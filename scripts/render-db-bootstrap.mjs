import { spawnSync } from 'node:child_process';
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const iterations = 4_096;
const saltLength = 16;

export function createScramVerifier(password, salt = randomBytes(saltLength)) {
  // Printable non-space ASCII is unchanged by PostgreSQL SCRAM's SASLprep.
  if (typeof password !== 'string' || !/^[\x21-\x7e]{24,128}$/.test(password)) {
    throw new Error('APP_DB_PASSWORD must be a generated 24–128 character printable ASCII password without spaces.');
  }
  if (!Buffer.isBuffer(salt) || salt.length !== saltLength) throw new Error('Invalid SCRAM salt.');

  const saltedPassword = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', saltedPassword).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest('base64');
  const serverKey = createHmac('sha256', saltedPassword).update('Server Key').digest('base64');
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey}:${serverKey}`;
}

export function runBootstrap([database = 'amazegame-db', ...extra], settings = process.env, spawn = spawnSync) {
  if (extra.length || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(database)) {
    throw new Error('Usage: node scripts/render-db-bootstrap.mjs [Render database name or ID]');
  }

  const env = { ...settings };
  for (const name of Object.keys(env)) {
    if (/^(APP_DB_PASSWORD|APP_DB_SCRAM_VERIFIER)$/i.test(name)) delete env[name];
  }
  env.APP_DB_SCRAM_VERIFIER = createScramVerifier(settings.APP_DB_PASSWORD);

  const script = fileURLToPath(new URL('../database/render-bootstrap.sql', import.meta.url));
  const args = ['psql', database, '--command', '\\set QUIET on', '--output', 'text', '--', '-X', '-f', script];
  const result = spawn('render', args, { env, stdio: 'inherit' });
  if (result.error) throw new Error('Could not start the Render CLI. Verify that render and psql are available.');
  return result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = runBootstrap(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
