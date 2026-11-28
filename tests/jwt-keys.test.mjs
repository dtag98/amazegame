import assert from 'node:assert/strict';
import { createPublicKey } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { ensureJwtKeys } from '../scripts/ensure-jwt-keys.mjs';
import { loadJwtKeyPem } from '../shared/jwt-key.js';

const run = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/ensure-jwt-keys.mjs', import.meta.url));

test('concurrent auth startup preserves one signing key and can restore its public key', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'amazegame-key-test-'));
  context.after(() => rmSync(directory, { force: true, recursive: true }));
  const privatePath = join(directory, 'private', 'private.pem');
  const publicPath = join(directory, 'public', 'public.pem');
  const env = { ...process.env, JWT_PRIVATE_KEY: privatePath, JWT_PUBLIC_KEY: publicPath };
  delete env.JWT_PRIVATE_KEY_PEM;
  delete env.JWT_PUBLIC_KEY_PEM;
  const options = { env };
  await Promise.all([run(process.execPath, [script], options), run(process.execPath, [script], options)]);

  const privateKey = loadJwtKeyPem(env, 'JWT_PRIVATE_KEY');
  const publicKey = loadJwtKeyPem(env, 'JWT_PUBLIC_KEY');
  assert.equal(createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }), publicKey);
  if (process.platform !== 'win32') assert.equal(statSync(privatePath).mode & 0o777, 0o600);

  rmSync(publicPath);
  ensureJwtKeys(privatePath, publicPath);
  assert.ok(readFileSync(privatePath, 'utf8') === privateKey, 'private signing key was preserved');
  assert.equal(readFileSync(publicPath, 'utf8'), publicKey);
});

test('an environment signing key skips local PEM generation', async () => {
  await run(process.execPath, [script], { env: { JWT_PRIVATE_KEY_PEM: 'validated by auth at startup' } });
});

test('missing, empty and unreadable keys report which setting to fix', () => {
  assert.throws(() => loadJwtKeyPem({ JWT_SECRET: 'old secret' }, 'JWT_PRIVATE_KEY'),
    { message: 'Set JWT_PRIVATE_KEY_PEM to a PEM key or JWT_PRIVATE_KEY to a PEM file path.' });
  assert.throws(() => loadJwtKeyPem({ JWT_PUBLIC_KEY_PEM: ' ' }, 'JWT_PUBLIC_KEY'),
    { message: 'JWT_PUBLIC_KEY_PEM must contain a PEM key.' });
  assert.throws(() => loadJwtKeyPem({ JWT_PRIVATE_KEY: '\0sensitive input' }, 'JWT_PRIVATE_KEY'),
    { message: 'Could not read the PEM file configured by JWT_PRIVATE_KEY.' });
});

test('a corrupt existing private key fails startup instead of silently rotating', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'amazegame-key-test-'));
  context.after(() => rmSync(directory, { force: true, recursive: true }));
  const privatePath = join(directory, 'private.pem');
  writeFileSync(privatePath, 'invalid test key');
  assert.throws(() => ensureJwtKeys(privatePath, join(directory, 'public.pem')));
  assert.equal(readFileSync(privatePath, 'utf8'), 'invalid test key');
});
