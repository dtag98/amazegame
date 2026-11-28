import assert from 'node:assert/strict';
import test from 'node:test';
import { createScramVerifier, runBootstrap } from '../scripts/render-db-bootstrap.mjs';

const fixturePassword = 'RenderScramFixturePassword2026!';

test('builds the PostgreSQL SCRAM verifier for a known password and salt', () => {
  const salt = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
  assert.equal(
    createScramVerifier(fixturePassword, salt),
    'SCRAM-SHA-256$4096:AAECAwQFBgcICQoLDA0ODw==$gBwM4IORZ96bnCHj9twBBktgSOyui8zCAjUa6x/Walw=:/lwfDeI/NJg1E1pXBPKj2b2JLYtsjoLt4VSJHoIDTyI=',
  );
});

test('rejects unsuitable passwords before launching psql', () => {
  const spawn = () => assert.fail('Invalid password reached the Render CLI');
  for (const password of [undefined, 'too-short', `${fixturePassword}\n`, `${fixturePassword} é`]) {
    assert.throws(() => runBootstrap([], { APP_DB_PASSWORD: password }, spawn), /APP_DB_PASSWORD must be/);
  }
});

test('starts Render psql with a fresh verifier and no application plaintext', () => {
  const settings = { APP_DB_PASSWORD: fixturePassword, app_db_password: fixturePassword, app_db_scram_verifier: 'replace me' };
  const status = runBootstrap(['dpg-test'], settings, (file, args, { env, stdio }) => {
    assert.equal(file, 'render');
    assert.deepEqual(args.slice(0, -1), ['psql', 'dpg-test', '--command', '\\set QUIET on', '--output', 'text', '--', '-X', '-f']);
    assert.match(args.at(-1), /[\\/]database[\\/]render-bootstrap\.sql$/);
    assert.equal(stdio, 'inherit');
    assert.equal('APP_DB_PASSWORD' in env, false);
    assert.equal(JSON.stringify({ args, env }).includes(fixturePassword), false);
    assert.match(env.APP_DB_SCRAM_VERIFIER, /^SCRAM-SHA-256\$4096:/);
    return { status: 7 };
  });
  assert.equal(status, 7);
});
