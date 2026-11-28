export function revocationRedisUrl(env, role) {
  const hostport = env.SESSION_REVOCATIONS_REDIS_HOSTPORT;
  const password = env.SESSION_REVOCATIONS_REDIS_PASSWORD;
  if (!hostport && !password && env.RENDER !== 'true' && !env.SESSION_REVOCATIONS_REDIS_URL) return null;

  const address = /^([A-Za-z0-9.-]+):([1-9][0-9]{0,4})$/.exec(hostport ?? '');
  if (!address || Number(address[2]) > 65_535 || !/^[A-Za-z0-9_+/=-]{32,128}$/.test(password ?? '')) {
    throw new Error('Configure the private revocation-store address and a generated role password.');
  }

  const url = new URL(`redis://${hostport}`);
  url.username = role;
  url.password = password;
  return url.href;
}
