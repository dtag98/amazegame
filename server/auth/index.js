import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const app = express();
const origin = process.env.PUBLIC_ORIGIN ?? 'http://localhost';
const secure = process.env.COOKIE_SECURE === 'true';
const cookieOptions = { httpOnly: true, secure, sameSite: 'lax', path: '/' };
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
const jwtSecret = process.env.JWT_SECRET;
const jwtAlgorithm = jwtSecret ? 'HS256' : 'RS256';
const privateKey = jwtSecret ?? readFileSync(process.env.JWT_PRIVATE_KEY, 'utf8');
app.disable('x-powered-by');
app.use(helmet({ hsts: secure ? { maxAge: 31536000, includeSubDomains: true } : false, contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'", origin.replace(/^http/, 'ws')], objectSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'self'"] } } }));
app.use(cors({ origin, credentials: true, methods: ['GET', 'POST'], allowedHeaders: ['Content-Type', 'X-CSRF-Token'] }));
app.use(express.json({ limit: '8kb', strict: true }));
app.use(cookieParser());
const csrfCookie = { secure, sameSite: 'lax', path: '/' };
function csrfToken() { return randomBytes(32).toString('hex'); }
function csrfValid(req) {
  const cookie = req.cookies.csrf;
  const header = req.get('x-csrf-token');
  if (!cookie || !header || !/^[a-f0-9]{64}$/.test(cookie) || !/^[a-f0-9]{64}$/.test(header)) return false;
  return timingSafeEqual(Buffer.from(cookie), Buffer.from(header));
}
function stateGuard(req, res, next) {
  if (process.env.TRUST_PROXY_ORIGIN !== 'true' && req.get('origin') !== origin) return res.status(403).json({ error: 'Forbidden' });
  if (!csrfValid(req)) return res.status(403).json({ error: 'CSRF validation failed' });
  next();
}
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many attempts. Try again later.' } });
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/csrf-token', (_req, res) => {
  const token = csrfToken();
  res.cookie('csrf', token, csrfCookie);
  res.json({ csrfToken: token });
});
const validFields = (body) => body && typeof body === 'object' && !Array.isArray(body);
function validateCredentials(req, res, next) {
  const { username, email, password } = req.body ?? {};
  if (!validFields(req.body) || typeof username !== 'string' || !/^[A-Za-z0-9_]{3,24}$/.test(username) || typeof password !== 'string' || password.length < 10 || password.length > 72) return res.status(400).json({ error: 'Invalid credentials format' });
  if (req.path === '/register' && (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return res.status(400).json({ error: 'Invalid credentials format' });
  next();
}
app.post('/register', stateGuard, authLimiter, validateCredentials, async (req, res) => {
  const { username, email, password } = req.body;
  try {
    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query('INSERT INTO accounts (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, username', [username, email.toLowerCase(), hash]);
    res.status(201).json({ user: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Account could not be created' });
    console.error('Registration database operation failed');
    res.status(500).json({ error: 'Request failed' });
  }
});
app.post('/login', stateGuard, authLimiter, validateCredentials, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, username, password_hash FROM accounts WHERE username = $1', [req.body.username]);
    const account = result.rows[0];
    const ok = await bcrypt.compare(req.body.password, account?.password_hash ?? '$2a$12$C6UzMDM.H6dfI/f/IKcEe.9a5y4m5fBT6U3NnbHAg8oXw4yAfM0aK');
    if (!account || !ok) return res.status(401).json({ error: 'Invalid username or password' });
    const token = jwt.sign({ sub: account.id, username: account.username }, privateKey, { algorithm: jwtAlgorithm, expiresIn: '30m', issuer: 'amazegame-auth', audience: 'amazegame' });
    res.cookie('session', token, { ...cookieOptions, maxAge: 30 * 60 * 1000 });
    res.json({ user: { id: account.id, username: account.username } });
  } catch {
    console.error('Login operation failed');
    res.status(500).json({ error: 'Request failed' });
  }
});
app.post('/logout', stateGuard, (_req, res) => { res.clearCookie('session', cookieOptions); res.status(204).end(); });
function verifySession(token) {
  const verificationKey = jwtSecret ?? readFileSync(process.env.JWT_PUBLIC_KEY, 'utf8');
  return jwt.verify(token, verificationKey, { algorithms: [jwtAlgorithm], issuer: 'amazegame-auth', audience: 'amazegame' });
}
app.get('/me', (req, res) => {
  try {
    const claims = verifySession(req.cookies.session ?? '');
    res.json({ user: { id: claims.sub, username: claims.username } });
  } catch { res.status(401).json({ error: 'Unauthorized' }); }
});
app.use((err, _req, res, _next) => { if (err instanceof SyntaxError) return res.status(400).json({ error: 'Invalid request' }); res.status(500).json({ error: 'Request failed' }); });
async function start() {
  if (process.env.AUTO_MIGRATE === 'true') {
    await pool.query(`CREATE TABLE IF NOT EXISTS accounts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      username VARCHAR(24) NOT NULL UNIQUE,
      email VARCHAR(254) NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  }
  app.listen(Number(process.env.PORT ?? 3001), '0.0.0.0');
}
start().catch(error => { console.error('Authentication service startup failed'); console.error(error.message); process.exit(1); });
