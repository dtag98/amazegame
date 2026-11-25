import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

function readIfPresent(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

function publish(path, contents, mode, replace) {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, contents, { flag: 'wx', mode });
    if (replace) {
      renameSync(temporaryPath, path);
    } else {
      // A second startup must keep the private key published by the first.
      try {
        linkSync(temporaryPath, path);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

export function ensureJwtKeys(privatePath, publicPath) {
  mkdirSync(dirname(privatePath), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(publicPath), { recursive: true, mode: 0o755 });

  let privatePem = readIfPresent(privatePath);
  if (privatePem === null) {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 3072,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    publish(privatePath, privateKey, 0o600, false);
    privatePem = readFileSync(privatePath, 'utf8');
  }

  const privateKey = createPrivateKey(privatePem);
  if (privateKey.asymmetricKeyType !== 'rsa' || privateKey.asymmetricKeyDetails.modulusLength < 2048) {
    throw new Error('The signing key must be RSA with a modulus of at least 2048 bits.');
  }
  const publicPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
  if (readIfPresent(publicPath) !== publicPem) publish(publicPath, publicPem, 0o644, true);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { JWT_PRIVATE_KEY, JWT_PUBLIC_KEY } = process.env;
  if (!JWT_PRIVATE_KEY || !JWT_PUBLIC_KEY) throw new Error('Set both JWT key paths on the auth service.');
  ensureJwtKeys(JWT_PRIVATE_KEY, JWT_PUBLIC_KEY);
}
