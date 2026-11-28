import assert from 'node:assert/strict';
import { createHash, createPrivateKey, generateKeyPairSync, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
import { createSessionVerifier } from '../server/game/session.js';
import { loadJwtKeyPem } from '../shared/jwt-key.js';

const jwt = createRequire(new URL('../server/game/package.json', import.meta.url))('jsonwebtoken');
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicPem = keys.publicKey.export({ type: 'spki', format: 'pem' });
const verify = createSessionVerifier(publicPem, 'session');
const now = Math.floor(Date.now() / 1000);
const account = { id: randomUUID(), username: 'test_player' };
const claims = {
  iss: 'amazegame-auth', aud: 'amazegame', sub: account.id,
  username: account.username, iat: now, exp: now + 1800,
};
function signed(data, { algorithm = 'RS256', privateKey = keys.privateKey } = {}) {
  return jwt.sign(data, privateKey, { algorithm });
}

test('verifier returns identity, expiry and a token digest for a trusted session', () => {
  const token = signed(claims);
  assert.deepEqual(verify(`csrf=sample; session=${token}; preference=sample`), {
    ...account,
    expiresAt: claims.exp * 1000,
    sessionId: createHash('sha256').update(token).digest('hex'),
  });
});

test('verifier rejects absent, unparseable, ambiguous, and oversized cookies', () => {
  for (const cookie of [undefined, 'csrf=sample', 'session=unreadable',
    `session=${signed(claims)}; session=${signed(claims)}`, `session=${'a'.repeat(2049)}`]) {
    assert.equal(verify(cookie), null);
  }
});

test('verifier requires the configured signer and exact signature algorithm', () => {
  assert.equal(verify(`session=${signed(claims, { privateKey: otherKeys.privateKey })}`), null);
  assert.equal(verify(`session=${signed(claims, { algorithm: 'RS384' })}`), null);
});

test('verifier rejects expired, missing, inconsistent, and overlong lifetimes', () => {
  const { exp: _expiration, ...withoutExpiration } = claims;
  const cases = [withoutExpiration, { ...claims, exp: now - 1, iat: now - 60 },
    { ...claims, iat: now + 1800 }, { ...claims, exp: now + 1801 }];
  for (const data of cases) assert.equal(verify(`session=${signed(data)}`), null);
});

test('verifier requires the expected service and a valid account identity', () => {
  const cases = [{ iss: 'another-auth' }, { aud: 'another-app' }, { sub: 'missing-account-id' },
    { username: 'not a supported username' }, { username: undefined }];
  for (const overrides of cases) {
    assert.equal(verify(`session=${signed({ ...claims, ...overrides })}`), null);
  }
});

test('verifier startup requires public key material', () => {
  const privatePem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
  assert.throws(() => createSessionVerifier(privatePem, 'session'), /public key/);
});

test('RSA keys from the environment sign and verify a session without key files', () => {
  const signingEnv = { JWT_PRIVATE_KEY_PEM: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const verificationEnv = { JWT_PUBLIC_KEY_PEM: publicPem };
  const privateKey = createPrivateKey(loadJwtKeyPem(signingEnv, 'JWT_PRIVATE_KEY'));
  const verifyEnvSession = createSessionVerifier(loadJwtKeyPem(verificationEnv, 'JWT_PUBLIC_KEY'), 'session');
  const token = signed(claims, { privateKey });
  assert.equal(verifyEnvSession(`session=${token}`)?.id, account.id);
});
