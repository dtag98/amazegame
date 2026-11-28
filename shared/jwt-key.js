import { readFileSync } from 'node:fs';

export function loadJwtKeyPem(env, keyVariable) {
  const pemVariable = `${keyVariable}_PEM`;
  const pem = env[pemVariable]?.trim();
  if (pem !== undefined) {
    if (!pem) throw new Error(`${pemVariable} must contain a PEM key.`);
    return pem;
  }

  const path = env[keyVariable];
  if (!path) throw new Error(`Set ${pemVariable} to a PEM key or ${keyVariable} to a PEM file path.`);
  try {
    return readFileSync(path, 'utf8');
  } catch {
    throw new Error(`Could not read the PEM file configured by ${keyVariable}.`);
  }
}
