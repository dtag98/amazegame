import { existsSync, writeFileSync, chmodSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
const privatePath = process.env.JWT_PRIVATE_KEY ?? '/run/keys/private.pem';
const publicPath = process.env.JWT_PUBLIC_KEY ?? '/run/keys/public.pem';
if (!existsSync(privatePath) || !existsSync(publicPath)) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  writeFileSync(privatePath, privateKey, { mode: 0o600 });
  writeFileSync(publicPath, publicKey, { mode: 0o644 });
  chmodSync(privatePath, 0o600);
}
