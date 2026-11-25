import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRevocations } from '../shared/revocations.js';

test('revocation is shared across verifier instances and retained until expiry', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'amazegame-revocations-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const writer = createRevocations(directory);
  const reader = createRevocations(directory);
  const session = { sessionId: randomBytes(32).toString('hex'), expiresAt: Date.now() + 60_000 };
  const anotherSession = { ...session, sessionId: randomBytes(32).toString('hex') };
  assert.equal(reader.isRevoked(session), false);

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      stop();
      reject(new Error('Session revocation was not observed'));
    }, 2000);
    const stop = reader.watch(() => {
      if (reader.isRevoked(session)) {
        stop();
        clearTimeout(timeout);
        resolve();
      }
    });
    writer.revoke(session);
  });
  writer.revoke(session);
  assert.equal(readdirSync(directory).length, 1, 'repeated logout reuses the same marker');
  assert.equal(createRevocations(directory).isRevoked(session), true, 'restart reads the same marker');
  assert.equal(reader.isRevoked(anotherSession), false);

  writer.prune(session.expiresAt - 1);
  assert.equal(reader.isRevoked(session), true);
  writer.prune(session.expiresAt);
  assert.equal(readdirSync(directory).length, 0);
});
