import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { createClient } from '@redis/client';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import { createPrivateKey, createPublicKey, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  browserConfig, JWT_ALGORITHM, JWT_AUDIENCE, JWT_ISSUER,
  SESSION_TTL_SECONDS, USERNAME_PATTERN,
} from '../../shared/auth.js';
import { createRevocations } from '../../shared/revocations.js';
import { loadJwtKeyPem } from '../../shared/jwt-key.js';
import { connectRevocationRedis } from '../../shared/connect-revocation-redis.js';
import { revocationRedisUrl } from '../../shared/revocation-redis-config.js';
import { createRedisRevocationWriter } from '../../shared/redis-revocations.js';
import { createSessionVerifier } from '../../shared/session.js';
import { createLoginThrottle, createPasswordWorkQueue, PasswordWorkTimeoutError } from './password-work.js';

const { origin, secure, sessionCookie, csrfCookie, cookieOptions } = browserConfig(process.env.PUBLIC_ORIGIN);
const privateKey = createPrivateKey(loadJwtKeyPem(process.env, 'JWT_PRIVATE_KEY'));
if (privateKey.asymmetricKeyType !== 'rsa' || privateKey.asymmetricKeyDetails.modulusLength < 2048) {
  throw new Error('JWT_PRIVATE_KEY must contain an RSA private key of at least 2048 bits.');
}
const publicKeyPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
const verifySession = createSessionVerifier(publicKeyPem, sessionCookie, jwt);
const revocationsRedisUrl = revocationRedisUrl(process.env, 'writer');
let redis;
let revocations;
const AUTH_REQUESTS_PER_IP_PER_ROUTE = 60;
const passwordWork = createPasswordWorkQueue({ maxQueuedPerKind: AUTH_REQUESTS_PER_IP_PER_ROUTE });
const loginThrottle = createLoginThrottle();

const pool = new pg.Pool({ max: 10, connectionTimeoutMillis: 3000, statement_timeout: 5000 });
pool.on('error', () => console.error('Idle authentication database connection failed'));
const app = express();
if (process.env.TRUST_NGINX === 'true') app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({
  strictTransportSecurity: secure ? { maxAge: 31_536_000 } : false,
  contentSecurityPolicy: { directives: { upgradeInsecureRequests: secure ? [] : null } },
}));
app.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use(cookieParser());

const csrfPattern = /^[a-f0-9]{64}$/;
function stateGuard(req, res, next) {
  const cookie = req.cookies[csrfCookie];
  const header = req.get('X-CSRF-Token');
  if (req.get('Origin') !== origin || typeof cookie !== 'string' || typeof header !== 'string'
      || !csrfPattern.test(cookie) || !csrfPattern.test(header)
      || !timingSafeEqual(Buffer.from(cookie, 'hex'), Buffer.from(header, 'hex'))) {
    return res.status(403).json({ error: 'Request did not pass the origin and CSRF checks' });
  }
  next();
}

const json = express.json({ limit: '8kb', strict: true });
const attemptLimit = limit => rateLimit({
  windowMs: 60_000,
  limit,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many attempts. Try again later.' },
});

function retryLater(res, status = 503, retryAfter = 1) {
  const error = status === 429 ? 'Too many attempts. Try again later.' : 'Authentication is temporarily busy. Try again.';
  return res.set('Retry-After', String(retryAfter)).status(status).json({ error });
}

async function revokeCurrentSession(req, res) {
  const session = verifySession(req.headers.cookie);
  try {
    if (session) await revocations.revoke(session);
    return true;
  } catch {
    console.error('Could not revoke the previous browser session');
    retryLater(res);
    return false;
  }
}

app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/csrf-token', (req, res) => {
  const existing = req.cookies[csrfCookie];
  const token = typeof existing === 'string' && csrfPattern.test(existing)
    ? existing : randomBytes(32).toString('hex');
  res.cookie(csrfCookie, token, cookieOptions);
  res.json({ csrfToken: token });
});

function validCredentials(username, password) {
  return typeof username === 'string' && USERNAME_PATTERN.test(username)
    && typeof password === 'string' && password.length >= 10 && password.length <= 72
    && !password.includes('\0') && !bcrypt.truncates(password);
}

const HASH_COST = 12;
// A valid fixed-cost hash keeps unknown users on the same bcrypt verification path.
const DUMMY_PASSWORD_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEe.9a5y4m5fBT6U3NnbHAg8oXw4yAfM0aK';

app.post('/register', stateGuard, attemptLimit(AUTH_REQUESTS_PER_IP_PER_ROUTE), json, async (req, res) => {
  const { username, password } = req.body ?? {};
  if (!validCredentials(username, password)) {
    return res.status(400).json({ error: 'Enter a valid username and password (10+ characters, up to 72 UTF-8 bytes)' });
  }

  try {
    const pending = passwordWork.run('register', async () => {
      const hash = await bcrypt.hash(password, HASH_COST);
      const { rows } = await pool.query(
        'INSERT INTO accounts (username, password_hash) VALUES ($1, $2) RETURNING id, username',
        [username, hash],
      );
      return rows[0];
    });
    if (!pending) return retryLater(res);
    res.status(201).json({ user: await pending });
  } catch (error) {
    if (error instanceof PasswordWorkTimeoutError) return retryLater(res);
    if (error.code === '23505') return res.status(409).json({ error: 'Account could not be created' });
    console.error('Registration database operation failed');
    res.status(500).json({ error: 'Request failed' });
  }
});

app.post('/login', stateGuard, attemptLimit(AUTH_REQUESTS_PER_IP_PER_ROUTE), json, async (req, res) => {
  const { username, password } = req.body ?? {};
  if (!validCredentials(username, password)) return res.status(400).json({ error: 'Invalid credentials format' });
  const attempt = loginThrottle.begin(username);
  if (attempt.status) return retryLater(res, attempt.status, attempt.retryAfter);

  let verified;
  try {
    const pending = passwordWork.run('login', async () => {
      const { rows: [account] } = await pool.query('SELECT id, username, password_hash FROM accounts WHERE username = $1', [username]);
      const passwordMatches = await bcrypt.compare(password, account?.password_hash ?? DUMMY_PASSWORD_HASH);
      return account && passwordMatches ? account : null;
    });
    if (!pending) return retryLater(res);
    const account = await pending;
    verified = Boolean(account);
    if (!account) return res.status(401).json({ error: 'Invalid username or password' });

    const token = jwt.sign({ sub: account.id, username: account.username }, privateKey, {
      algorithm: JWT_ALGORITHM,
      expiresIn: SESSION_TTL_SECONDS,
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      jwtid: randomUUID(),
    });
    if (!(await revokeCurrentSession(req, res))) return;
    res.cookie(sessionCookie, token, { ...cookieOptions, maxAge: SESSION_TTL_SECONDS * 1000 });
    res.json({ user: { id: account.id, username: account.username } });
  } catch (error) {
    if (error instanceof PasswordWorkTimeoutError) return retryLater(res);
    console.error('Login operation failed');
    res.status(500).json({ error: 'Request failed' });
  } finally {
    attempt.finish(verified);
  }
});

app.post('/logout', stateGuard, attemptLimit(AUTH_REQUESTS_PER_IP_PER_ROUTE), async (req, res) => {
  if (!(await revokeCurrentSession(req, res))) return;
  res.clearCookie(sessionCookie, cookieOptions);
  res.clearCookie(csrfCookie, cookieOptions);
  res.status(204).end();
});

app.all(['/register', '/login', '/logout'], (_req, res) => {
  res.set('Allow', 'POST').status(405).json({ error: 'Use POST for this request' });
});
app.use((error, _req, res, _next) => {
  if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Request body is too large' });
  if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  if (error.status === 415) return res.status(415).json({ error: 'Unsupported request body format' });
  res.status(500).json({ error: 'Request failed' });
});

try {
  await pool.query('SELECT id FROM accounts LIMIT 1');
  if (revocationsRedisUrl) redis = await connectRevocationRedis(createClient, revocationsRedisUrl);
  revocations = redis ? await createRedisRevocationWriter(redis) : createRevocations(process.env.SESSION_REVOCATIONS_DIR);
  await revocations.prune();
  app.listen(Number(process.env.PORT ?? 3001), '0.0.0.0');
  setInterval(async () => {
    try {
      await revocations.prune();
    } catch {
      console.error('Could not prune expired session revocations');
    }
  }, 60_000).unref();
} catch {
  console.error('Authentication service could not initialize its database or session state');
  if (redis?.isOpen) redis.destroy();
  await pool.end();
  process.exitCode = 1;
}
