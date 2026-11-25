import jwt from 'jsonwebtoken';
import { createSessionVerifier as createVerifier } from '../../shared/session.js';

export function createSessionVerifier(publicKeyPem, cookieName) {
  return createVerifier(publicKeyPem, cookieName, jwt);
}
