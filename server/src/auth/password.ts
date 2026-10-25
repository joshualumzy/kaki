import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

const ALGORITHM = 'scrypt';
const SALT_BYTES = 16;
const KEY_BYTES = 64;

/** Hash a password with scrypt and a fresh random salt; the result is safe to store. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = (await scrypt(password, salt, KEY_BYTES)) as Buffer;
  return `${ALGORITHM}:${salt.toString('hex')}:${hash.toString('hex')}`;
}

/** Check a password against a stored scrypt hash in constant time. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== ALGORITHM) return false;

  const saltHex = parts[1];
  const hashHex = parts[2];
  if (saltHex === undefined || hashHex === undefined) return false;
  if (!/^[0-9a-f]+$/.test(saltHex) || !/^[0-9a-f]+$/.test(hashHex)) return false;

  const expected = Buffer.from(hashHex, 'hex');
  if (expected.length === 0) return false;

  try {
    const actual = (await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length)) as Buffer;
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

/** The only form of a session token the database is allowed to hold. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
