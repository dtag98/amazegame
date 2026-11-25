export const JWT_ALGORITHM = 'RS256';
export const JWT_ISSUER = 'amazegame-auth';
export const JWT_AUDIENCE = 'amazegame';
export const SESSION_TTL_SECONDS = 30 * 60;
export const SESSION_ENDED_CLOSE_CODE = 4401;
export const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,24}$/;
export const ACCOUNT_ID_PATTERN = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export function browserConfig(value = 'http://localhost:8080') {
  const url = new URL(value);
  const secure = url.protocol === 'https:';
  const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (value !== url.origin || !(secure || localHttp)) {
    throw new Error('PUBLIC_ORIGIN must be an exact HTTPS origin or a loopback HTTP origin.');
  }

  // The browser enforces host-only, root-path cookies for the __Host- prefix.
  return {
    origin: url.origin,
    secure,
    sessionCookie: secure ? '__Host-session' : 'session',
    csrfCookie: secure ? '__Host-csrf' : 'csrf',
    cookieOptions: { httpOnly: true, secure, sameSite: 'lax', path: '/' },
  };
}
