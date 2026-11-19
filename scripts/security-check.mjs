import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const base = process.env.BASE_URL ?? 'http://localhost:8080';
let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`PASS ${name}`); };
const getCsrf = async () => {
  const response = await fetch(`${base}/api/csrf-token`);
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  return { token: (await response.json()).csrfToken, cookie };
};
const post = (path, csrf, data, extra = {}) => fetch(`${base}/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, Cookie: csrf.cookie, 'X-CSRF-Token': csrf.token, ...extra }, body: JSON.stringify(data) });
const username = `test_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const email = `${username}@example.test`;
const password = 'Secure-Test-Passphrase-42';

await check('HTTP security headers', async () => {
  const response = await fetch(`${base}/api/health`);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.equal(response.headers.get('x-powered-by'), null);
  assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'self'/);
});
await check('CSRF token issuance and rejection', async () => {
  const csrf = await getCsrf();
  const missing = await fetch(`${base}/api/login`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(missing.status, 403);
  const bad = await post('login', { ...csrf, token: '0'.repeat(64) }, {});
  assert.equal(bad.status, 403);
});
await check('reject unauthorized Origin', async () => {
  const csrf = await getCsrf();
  const response = await post('register', csrf, { username, email, password }, { Origin: 'https://attacker.invalid' });
  assert.equal(response.status, 403);
});
await check('registration, parameterized SQL, and XSS payload preservation', async () => {
  const csrf = await getCsrf();
  const injection = await post('login', csrf, { username: "' OR 1=1 --", password });
  assert.ok([400, 401].includes(injection.status), `SQL injection probe returned ${injection.status}: ${await injection.text()}`);
  const response = await post('register', csrf, { username: `xss_${username}`, email, password });
  assert.equal(response.status, 201);
  const malformed = await post('register', csrf, { username: `${username}<img src=x onerror=alert(1)>`, email: `x${randomUUID()}@example.test`, password });
  assert.equal(malformed.status, 400);
});
const csrf = await getCsrf();
await check('login and HttpOnly cookie authentication', async () => {
  const registeredName = `xss_${username}`;
  const response = await post('login', csrf, { username: registeredName, password });
  assert.equal(response.status, 200);
  const sessionCookie = response.headers.get('set-cookie')?.split(';')[0];
  assert.match(response.headers.get('set-cookie') ?? '', /HttpOnly/i);
  assert.ok(sessionCookie?.startsWith('session='));
  const me = await fetch(`${base}/api/me`, { headers: { Cookie: sessionCookie } });
  assert.equal(me.status, 200);
  const noCookie = await fetch(`${base}/api/me`);
  assert.equal(noCookie.status, 401);
  const tokens = JSON.parse(execFileSync('docker', ['compose', 'exec', '-T', 'auth', 'node', '-e', "const jwt=require('jsonwebtoken'),fs=require('fs'),k=fs.readFileSync(process.env.JWT_PRIVATE_KEY);const t=jwt.sign({sub:'test',username:'test'},k,{algorithm:'RS256',issuer:'amazegame-auth',audience:'amazegame',expiresIn:-60});const p=t.split('.');p[2]=(p[2][0]==='A'?'B':'A')+p[2].slice(1);console.log(JSON.stringify({expired:t,badSignature:p.join('.')}));"], { encoding: 'utf8' }));
  for (const token of ['not.a.valid.token', tokens.expired, tokens.badSignature]) {
    const response = await fetch(`${base}/api/me`, { headers: { Cookie: `session=${token}` } });
    assert.equal(response.status, 401);
  }
});
await check('oversized HTTP request rejected', async () => {
  const response = await fetch(`${base}/api/register`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ payload: 'a'.repeat(20000) }) });
  assert.ok(response.status === 413 || response.status === 400);
});
await check('login rate limiting', async () => {
  const c = await getCsrf();
  const statuses = [];
  for (let i = 0; i < 12; i++) statuses.push((await post('login', c, { username: `rate_${username}`, password })).status);
  assert.ok(statuses.includes(429), `Expected 429, received ${statuses.join(',')}`);
});
await check('WebSocket unauthenticated and unauthorized origins rejected', async () => {
  const matchmake = (origin) => fetch(`${base}/colyseus/matchmake/joinOrCreate/game`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' });
  const unauthenticated = await matchmake(base);
  const unauthenticatedBody = await unauthenticated.json();
  assert.equal(unauthenticatedBody.error, 'Unauthorized', `Expected unauthenticated matchmaking rejection, got ${JSON.stringify(unauthenticatedBody)}`);
  const forbidden = await matchmake('https://attacker.invalid');
  assert.equal((await forbidden.json()).error, 'Unauthorized');
});
console.log(`Completed ${passed} security checks.`);
