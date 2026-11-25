import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { SESSION_ENDED_CLOSE_CODE } from '../shared/auth.js';

const enabled = process.env.OBJECTIVE2_COMPOSE_TEST === '1';
const project = process.env.OBJECTIVE2_COMPOSE_PROJECT ?? '';
const cwd = fileURLToPath(new URL('..', import.meta.url));

function compose(args, { input, timeout = 30_000 } = {}) {
  const result = spawnSync('docker', ['compose', '--project-name', project, '--file', 'docker-compose.yml', ...args], {
    cwd, input, timeout, encoding: 'utf8', windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const reason = result.error?.code ?? (result.signal || `exit ${result.status}`);
    throw new Error(`Docker Compose ${args[0]} failed (${reason}).`);
  }
  return result.stdout.trim();
}

function browser(origin) {
  const cookies = new Map();

  async function request(path, { body, csrf, requestOrigin = origin } = {}) {
    const headers = new Headers();
    if (cookies.size) headers.set('Cookie', Array.from(cookies.values()).join('; '));
    if (csrf !== undefined) headers.set('X-CSRF-Token', csrf);
    if (body !== undefined) {
      headers.set('Content-Type', 'application/json');
      if (requestOrigin) headers.set('Origin', requestOrigin);
    }
    const response = await fetch(`${origin}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers, body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual', signal: AbortSignal.timeout(10_000),
    });
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(';', 1)[0];
      const separator = pair.indexOf('=');
      if (separator < 1) continue;
      const name = pair.slice(0, separator);
      if (pair.endsWith('=') || /;\s*Max-Age=0\b/i.test(header)) cookies.delete(name);
      else cookies.set(name, pair);
    }
    return response;
  }

  async function issueCsrf(path = '/csrf-token') {
    const response = await request(path);
    assert.equal(response.status, 200, `${path} issues a CSRF token`);
    assertCookie(response, 'csrf');
    const { csrfToken } = await response.json();
    assert.ok(typeof csrfToken === 'string' && /^[a-f0-9]{64}$/.test(csrfToken));
    return csrfToken;
  }

  return { request, issueCsrf, cookies };
}

function assertCookie(response, name) {
  const cookie = response.headers.getSetCookie().find(header => header.startsWith(`${name}=`));
  assert.ok(cookie, `${name} cookie is set`);
  assert.ok(/;\s*HttpOnly(?:;|$)/i.test(cookie), `${name} is HttpOnly`);
  assert.ok(/;\s*SameSite=Lax(?:;|$)/i.test(cookie), `${name} uses SameSite=Lax`);
  assert.ok(/;\s*Path=\/(?:;|$)/i.test(cookie), `${name} has path /`);
  assert.ok(!/;\s*Domain=/i.test(cookie), `${name} has host-only scope`);
  assert.ok(!/;\s*Secure(?:;|$)/i.test(cookie), `${name} works on local HTTP`);
  return cookie;
}

async function assertIdentity(client, username, path = '/me') {
  const response = await client.request(path);
  assert.equal(response.status, 200, `${path} recognizes the logged-in account`);
  assert.ok(response.headers.get('cache-control')?.includes('no-store'), `${path} is private`);
  await assertUserResponse(response, username);
}

async function assertUserResponse(response, username) {
  const { user } = await response.json();
  assert.ok(user && Object.keys(user).sort().join(',') === 'id,username', 'response user contains only public account fields');
  assert.equal(user.username, username);
  assert.ok(typeof user.id === 'string' && /^[\da-f-]{36}$/i.test(user.id), 'account ID is a UUID');
}

async function assertIpRequestBudget(client, path, csrf, response, expectedLimit) {
  const budget = response.headers.get('ratelimit') ?? '';
  const limit = Number(budget.match(/\blimit=(\d+)\b/)?.[1]);
  const remaining = Number(budget.match(/\bremaining=(\d+)\b/)?.[1]);
  assert.equal(limit, expectedLimit, `${path} reports its per-IP request limit`);
  assert.ok(Number.isInteger(remaining) && remaining > 0 && remaining <= limit);

  for (let attempt = 0; attempt < remaining; attempt++) {
    assert.equal((await client.request(path, { body: {}, csrf })).status, 400);
  }
  assert.equal((await client.request(path, { body: {}, csrf })).status, 429,
    `${path} rejects requests beyond its IP budget`);
}

function verifyContainerIsolation() {
  const { services } = JSON.parse(compose(['config', '--format', 'json']));
  for (const service of ['auth', 'game', 'db', 'db-migrate']) {
    assert.equal(services[service].ports?.length ?? 0, 0, `${service} publishes no host ports`);
  }
  for (const service of Object.values(services)) {
    assert.equal(service.logging?.driver, 'local');
    assert.equal(service.logging?.options?.['max-size'], '10m');
    assert.equal(String(service.logging?.options?.['max-file']), '3');
  }
  const gameNetworks = Object.keys(services.game.networks ?? { default: undefined });
  const authNetworks = Object.keys(services.auth.networks ?? { default: undefined });
  const databaseNetworks = Object.keys(services.db.networks ?? { default: undefined });
  assert.ok(!gameNetworks.some(network => authNetworks.includes(network)), 'game cannot directly connect to auth');
  assert.ok(!gameNetworks.some(network => databaseNetworks.includes(network)), 'game cannot directly connect to PostgreSQL');
  const privateMount = services.auth.volumes?.find(volume => volume.target === '/run/jwt-private');
  assert.ok(privateMount, 'auth has the signing key volume');
  for (const service of ['game', 'nginx', 'db']) {
    assert.ok(!services[service].volumes?.some(volume => volume.source === privateMount.source), `signing volume is absent from ${service}`);
  }
  assert.ok(services.game.volumes?.some(volume => volume.target === '/run/jwt-public' && volume.read_only), 'game has a read-only public-key mount');
  const revocationsMount = services.game.volumes?.find(volume => volume.target === '/run/session-revocations');
  assert.ok(revocationsMount?.read_only, 'game has a read-only session revocation mount');
  assert.ok(services.auth.volumes?.some(volume => volume.source === revocationsMount.source && !volume.read_only),
    'only auth publishes session revocations');
  assert.ok(!('JWT_PRIVATE_KEY' in (services.game.environment ?? {})), 'game has no private key configured');
  assert.ok(!('JWT_SECRET' in (services.game.environment ?? {})), 'game has no shared signing secret');
  compose(['exec', '-T', 'game', 'node', '--input-type=module', '-e', `
    const origin = 'http://127.0.0.1:' + process.env.PORT;
    for (const path of ['/register', '/login', '/logout', '/api/register', '/api/login', '/api/logout']) {
      const response = await fetch(origin + path, { method: 'POST', signal: AbortSignal.timeout(2000) });
      if (response.status !== 404) process.exit(1);
    }
  `]);
}

function gamePublicKeyDigest() {
  const digest = compose(['exec', '-T', 'game', 'node', '--input-type=module', '-e', `
    import { createHash } from 'node:crypto';
    import { existsSync, readFileSync } from 'node:fs';
    for (const path of ['/run/jwt-private', '/run/jwt-public/private.pem', '/run/keys/private.pem']) {
      if (existsSync(path)) process.exit(1);
    }
    const publicKey = readFileSync(process.env.JWT_PUBLIC_KEY);
    console.log(createHash('sha256').update(publicKey).digest('hex'));
  `]);
  assert.ok(/^[a-f0-9]{64}$/.test(digest), 'game can read the public key while the private key is absent');
  return digest;
}

function queryAsDatabaseOwner(sql, first = '', second = '') {
  return compose(['exec', '-T', 'db', 'sh', '-c',
    'exec psql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --no-psqlrc --no-align --tuples-only --set=ON_ERROR_STOP=1 --set=first_account="$1" --set=second_account="$2" --file=-',
    'check-accounts', first, second,
  ], { input: sql });
}

function verifyStoredPasswords(first, second) {
  const hashes = queryAsDatabaseOwner(
    `SELECT password_hash FROM accounts WHERE username IN (:'first_account', :'second_account') ORDER BY username;\n`,
    first, second,
  ).split(/\r?\n/);
  assert.equal(hashes.length, 2, 'exactly two disposable accounts exist');
  assert.ok(hashes.every(hash => /^\$2[aby]\$12\$[./A-Za-z0-9]{53}$/.test(hash)), 'only BCrypt cost-12 password hashes are stored');
  assert.ok(hashes[0] !== hashes[1], 'equal passwords use different salts');
}

async function waitForGame(client) {
  for (let attempt = 0; attempt < 16; attempt++) {
    try { if ((await client.request('/health')).ok) return; } catch { /* service is restarting */ }
    await delay(500);
  }
  assert.fail('game did not become ready through nginx');
}

const matchmake = client => client.request('/colyseus/matchmake/joinOrCreate/game', { body: {} });

async function connectGameSocket(context, origin, client) {
  const requireGame = createRequire(new URL('../server/game/package.json', import.meta.url));
  const WebSocket = requireGame('ws');
  const { Protocol } = requireGame('@colyseus/shared-types');
  const reservation = await matchmake(client);
  assert.equal(reservation.status, 200, 'a signed-in user can reserve a game seat');
  const { processId, roomId, sessionId } = await reservation.json();
  const url = new URL(`/colyseus/${processId}/${roomId}`, origin.replace(/^http/, 'ws'));
  url.searchParams.set('sessionId', sessionId);
  const socket = new WebSocket(url, { origin, headers: { Cookie: Array.from(client.cookies.values()).join('; ') } });
  context.after(() => socket.terminate());
  const closed = new Promise(resolve => socket.once('close', resolve));
  const [message] = await once(socket, 'message', { signal: AbortSignal.timeout(5000) });
  assert.equal(message[0], Protocol.JOIN_ROOM, 'game sent the normal room handshake');
  socket.send(Uint8Array.of(Protocol.JOIN_ROOM));
  return { closed };
}

async function assertRoomClosed(room, timeoutMs) {
  const controller = new AbortController();
  try {
    const code = await Promise.race([
      room.closed,
      delay(timeoutMs, null, { signal: controller.signal }),
    ]);
    assert.equal(code, SESSION_ENDED_CLOSE_CODE, 'the server closed the room because the session ended');
  } finally {
    controller.abort();
  }
}

function shortLivedSession({ id, username }) {
  return compose(['exec', '-T', 'auth', 'node', '--input-type=module', '-e', `
    import { readFileSync } from 'node:fs';
    import jwt from 'jsonwebtoken';
    const fixture = JSON.parse(readFileSync(0, 'utf8'));
    const key = readFileSync(process.env.JWT_PRIVATE_KEY);
    console.log(jwt.sign({ sub: fixture.id, username: fixture.username }, key, {
      algorithm: 'RS256', issuer: 'amazegame-auth', audience: 'amazegame', expiresIn: 8,
    }));
  `], { input: JSON.stringify({ id, username }) });
}

test('Objective 2 through local nginx, auth, game and PostgreSQL', {
  skip: !enabled && 'opt in with OBJECTIVE2_COMPOSE_TEST=1 on a disposable Compose project', timeout: 210_000,
}, async context => {
  assert.match(project, /^objective2-[a-z0-9_-]+$/, 'set OBJECTIVE2_COMPOSE_PROJECT to a disposable project name starting with objective2-');
  const url = new URL(process.env.OBJECTIVE2_BASE_URL ?? 'http://localhost:8080');
  assert.ok(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
    url.href === `${url.origin}/`, 'test only a local HTTP origin');
  const origin = url.origin;
  const publication = compose(['port', 'nginx', '80']);
  assert.ok(publication.split(/\r?\n/).some(line => line.endsWith(`:${url.port || '80'}`)), 'the requested port belongs to test nginx');
  verifyContainerIsolation();
  const initialKey = gamePublicKeyDigest();
  const client = browser(origin);
  const guest = browser(origin);
  const html = await guest.request('/');
  assert.equal(html.status, 200, 'nginx serves the game homepage');
  assert.equal(html.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(html.headers.get('x-frame-options'), 'DENY');
  assert.equal(html.headers.get('x-powered-by'), null);
  assert.ok(html.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"));
  const landingPage = await html.text();
  for (const id of ['register', 'login', 'logout', 'status']) {
    assert.ok(new RegExp(`\\bid=["']${id}["']`).test(landingPage), `homepage contains ${id}`);
  }
  assert.equal((await guest.request('/me')).status, 401, 'a guest has no authenticated identity');
  assert.equal((await matchmake(guest)).status, 401,
    'a guest cannot reserve a game seat');

  const suffix = randomBytes(6).toString('hex');
  const password = `Objective2-${randomBytes(12).toString('hex')}`;
  const account = { username: `test_${suffix}`, password };
  const otherAccount = { username: `other_${suffix}`, password };
  const credentials = { username: account.username, password };
  const csrf = await client.issueCsrf();
  const guestCsrf = await guest.issueCsrf('/api/csrf-token');
  assert.equal((await client.request('/register', { body: account })).status, 403, 'registration requires a CSRF token');
  assert.equal((await client.request('/register', { body: account, csrf, requestOrigin: 'http://127.0.0.1:1' })).status, 403, 'registration requires the configured origin');
  assert.equal((await client.request('/register', { body: { ...account, password: 'é'.repeat(37) }, csrf })).status, 400, 'registration bounds BCrypt input by UTF-8 bytes');
  assert.equal((await client.request('/register', { body: { ...account, password: 'a'.repeat(9000) }, csrf })).status, 413, 'auth service bounds JSON body size');
  const registrations = await Promise.all([
    client.request('/register', { body: account, csrf }),
    guest.request('/api/register', { body: account, csrf: guestCsrf }),
  ]);
  assert.deepEqual(registrations.map(response => response.status).sort(), [201, 409], 'concurrent registration accepts the account once');
  await assertUserResponse(registrations.find(response => response.status === 201), account.username);
  const otherRegistration = await guest.request('/register', { body: otherAccount, csrf: guestCsrf });
  assert.equal(otherRegistration.status, 201, 'a different account can register');
  await assertIpRequestBudget(guest, '/register', guestCsrf, otherRegistration, 60);
  verifyStoredPasswords(account.username, otherAccount.username);
  assert.equal(queryAsDatabaseOwner(`SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'accounts' AND column_name = 'email';\n`),
    '0', 'a fresh account table collects no email addresses');
  context.diagnostic('Registration, CSRF, origin, password bounds and PostgreSQL storage verified');

  const wrong = await client.request('/api/login', { body: { ...credentials, password: 'Incorrect-Password-123' }, csrf });
  const unknown = await client.request('/login', { body: { ...credentials, username: `absent_${suffix}` }, csrf });
  assert.equal(wrong.status, 401, 'incorrect password denied');
  assert.equal(unknown.status, 401, 'unknown user denied');
  const wrongMessage = await wrong.json();
  const unknownMessage = await unknown.json();
  assert.ok(typeof wrongMessage.error === 'string' && wrongMessage.error === unknownMessage.error, 'failed login messages do not distinguish account existence');
  const login = await client.request('/login', { body: credentials, csrf });
  assert.equal(login.status, 200, 'correct password accepted');
  const identity = (await login.clone().json()).user;
  await assertUserResponse(login, account.username);
  assert.ok(/;\s*Max-Age=[1-9]\d*\b/i.test(assertCookie(login, 'session')), 'session cookie has a finite lifetime');
  const session = client.cookies.get('session');
  assert.ok(session, 'the browser received a session cookie');
  const [header, payload, signature] = decodeURIComponent(session.slice('session='.length)).split('.');
  assert.ok(signature && header && payload, 'JWT has all three segments');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  assert.equal(JSON.parse(Buffer.from(header, 'base64url').toString('utf8')).alg, 'RS256');
  assert.ok(Number.isSafeInteger(claims.exp) && claims.exp > Date.now() / 1000, 'JWT has a future expiration');
  await assertIdentity(client, account.username);
  await assertIdentity(client, account.username, '/api/me');
  const otherOrigin = 'http://127.0.0.1:1';
  const identityOptions = await fetch(`${origin}/me`, {
    method: 'OPTIONS', headers: { Origin: otherOrigin, 'Access-Control-Request-Method': 'GET' },
  });
  assert.notEqual(identityOptions.headers.get('access-control-allow-origin'), otherOrigin,
    'game does not reflect an untrusted origin on its identity endpoint');
  assert.ok([404, 405].includes((await client.request('/logout')).status), 'GET cannot log out');
  assert.equal((await client.request('/logout', { body: {} })).status, 403, 'logout requires a CSRF token');
  await assertIdentity(client, account.username);
  context.diagnostic('Login, RS256, cookie scope, guest rejection and logout guards verified');

  for (let attempt = 0; attempt < 3; attempt++) {
    const failure = await guest.request('/login', {
      body: { ...credentials, password: 'Incorrect-Password-123' }, csrf: guestCsrf,
    });
    assert.equal(failure.status, 401);
  }
  const accountThrottle = await guest.request('/login', { body: credentials, csrf: guestCsrf });
  assert.equal(accountThrottle.status, 429, 'repeated failures throttle the account before the IP budget is exhausted');
  assert.ok(Number(accountThrottle.headers.get('retry-after')) >= 1);

  await assertIpRequestBudget(guest, '/login', guestCsrf, accountThrottle, 60);

  try {
    compose(['down', '--timeout', '10']);
  } finally {
    compose(['up', '--detach', '--wait', '--wait-timeout', '55'], { timeout: 60_000 });
  }
  await waitForGame(guest);
  assert.ok(gamePublicKeyDigest() === initialKey, 'public key survives container recreation');
  await assertIdentity(client, account.username);
  assert.ok(client.cookies.get('session') === session, 'the original cookie remains valid without refresh');
  verifyStoredPasswords(account.username, otherAccount.username);
  context.diagnostic('Same login, key and account rows survived Compose down and up');

  try {
    compose(['stop', '--timeout', '10', 'auth', 'db']);
    await assertIdentity(client, account.username);
    assert.equal((await guest.request('/register', { body: account, csrf: guestCsrf })).status, 502, 'auth routes use the stopped auth upstream');
  } finally {
    compose(['up', '--detach', '--wait', '--wait-timeout', '55'], { timeout: 60_000 });
  }
  await waitForGame(guest);

  const expiring = browser(origin);
  expiring.cookies.set('session', `session=${shortLivedSession(identity)}`);
  const shortRoom = await connectGameSocket(context, origin, expiring);
  await assertRoomClosed(shortRoom, 9000);
  assert.equal((await expiring.request('/me')).status, 401, 'the expired session also fails HTTP verification');
  context.diagnostic('An already-open game socket was closed at JWT expiry');

  const firstTab = await connectGameSocket(context, origin, client);
  const secondTab = await connectGameSocket(context, origin, client);
  const otherBrowser = browser(origin);
  assert.equal((await otherBrowser.request('/login', { body: credentials, csrf: await otherBrowser.issueCsrf() })).status, 200);
  assert.equal((await matchmake(otherBrowser)).status, 429, 'the same account cannot exceed its room admission limit with another session');
  const logout = await client.request('/logout', { body: {}, csrf: await client.issueCsrf() });
  assert.equal(logout.status, 204, 'logout succeeds');
  assertCookie(logout, 'session');
  assert.ok(!client.cookies.has('session'), 'the browser cleared its session cookie');
  assert.equal((await client.request('/me')).status, 401, 'logged-out browser is a guest');
  await Promise.all([assertRoomClosed(firstTab, 3000), assertRoomClosed(secondTab, 3000)]);

  const previousSession = browser(origin);
  previousSession.cookies.set('session', session);
  assert.equal((await previousSession.request('/me')).status, 401, 'the logged-out session cannot be reused');
  assert.equal((await matchmake(previousSession)).status, 401, 'a revoked session cannot obtain a new seat');
  await assertIdentity(otherBrowser, account.username);
  compose(['restart', 'game']);
  await waitForGame(guest);
  assert.equal((await previousSession.request('/me')).status, 401, 'session revocation survives game restart');
  context.diagnostic('Account cap and cross-tab logout verified. The separate device stayed signed in, and revocation survived restart.');
});
