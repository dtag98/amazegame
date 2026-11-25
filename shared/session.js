import { createHash, createPublicKey } from 'node:crypto';
import {
  ACCOUNT_ID_PATTERN, JWT_ALGORITHM, JWT_AUDIENCE, JWT_ISSUER,
  SESSION_TTL_SECONDS, USERNAME_PATTERN,
} from './auth.js';

export function createSessionVerifier(publicKeyPem, cookieName, jwt) {
  if (!publicKeyPem.startsWith('-----BEGIN PUBLIC KEY-----')) {
    throw new Error('JWT_PUBLIC_KEY must contain an SPKI public key.');
  }
  const publicKey = createPublicKey(publicKeyPem);
  if (publicKey.asymmetricKeyType !== 'rsa' || publicKey.asymmetricKeyDetails.modulusLength < 2048) {
    throw new Error('JWT_PUBLIC_KEY must contain an RSA public key of at least 2048 bits.');
  }

  return (cookieHeader = '') => {
    if (typeof cookieHeader !== 'string') return null;
    const prefix = `${cookieName}=`;
    const sessionCookies = cookieHeader.split(';').map(value => value.trim())
      .filter(value => value.startsWith(prefix));
    if (sessionCookies.length !== 1) return null;
    const token = sessionCookies[0].slice(prefix.length);
    if (!token || token.length > 2048) return null;

    const segments = token.split('.');
    if (segments.length !== 3 || segments.some(segment => !segment
        || Buffer.from(segment, 'base64url').toString('base64url') !== segment)) return null;

    try {
      const claims = jwt.verify(token, publicKey, {
        algorithms: [JWT_ALGORITHM],
        audience: JWT_AUDIENCE,
        issuer: JWT_ISSUER,
      });
      if (typeof claims.sub !== 'string' || !ACCOUNT_ID_PATTERN.test(claims.sub)
          || typeof claims.username !== 'string' || !USERNAME_PATTERN.test(claims.username)
          || !Number.isSafeInteger(claims.exp) || !Number.isSafeInteger(claims.iat)
          || claims.iat > Math.floor(Date.now() / 1000)
          || claims.exp <= claims.iat || claims.exp - claims.iat > SESSION_TTL_SECONDS) return null;

      return {
        id: claims.sub,
        username: claims.username,
        sessionId: createHash('sha256').update(token).digest('hex'),
        expiresAt: claims.exp * 1000,
      };
    } catch {
      return null;
    }
  };
}
