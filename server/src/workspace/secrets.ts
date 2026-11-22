import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/** The message for every operation that needs the server's tool encryption key but has none. */
export const SECRET_KEY_MISSING_MESSAGE =
  "Kaki can't store tool logins until KAKI_SECRET_KEY is set on the server";

/** The message when a saved tool was encrypted under a different key than the current one. */
export const SECRET_KEY_WRONG_MESSAGE = 'this tool was saved with another key; reconnect it';

/** Why a tool secret could not be read or written. */
export type SecretKeyProblem = 'missing-key' | 'invalid-key' | 'wrong-key';

/** A typed failure for the server key: routes map it to a clear answer instead of a crash. */
export class SecretKeyError extends Error {
  constructor(
    readonly problem: SecretKeyProblem,
    message: string,
  ) {
    super(message);
    this.name = 'SecretKeyError';
  }
}

/** An encrypted token as it is stored: ciphertext, initialisation vector, auth tag and key id. */
export interface EncryptedSecret {
  secret: Buffer;
  iv: Buffer;
  tag: Buffer;
  keyId: string;
}

/** Parse the base64 KAKI_SECRET_KEY into exactly 32 bytes, or throw the typed setup error. */
export function parseSecretKey(raw: string | undefined): Buffer {
  if (raw === undefined || raw.trim() === '') {
    throw new SecretKeyError('missing-key', SECRET_KEY_MISSING_MESSAGE);
  }
  const key = Buffer.from(raw.trim(), 'base64');
  if (key.length !== 32) {
    throw new SecretKeyError('invalid-key', SECRET_KEY_MISSING_MESSAGE);
  }
  return key;
}

/** The short fingerprint stored with every secret, so a changed key is detected on read. */
export function keyIdOf(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 8);
}

/** True when the server has a usable tool encryption key. */
export function hasSecretKey(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    parseSecretKey(env.KAKI_SECRET_KEY);
    return true;
  } catch {
    return false;
  }
}

/** Log the missing tool encryption key once at startup, in plain words. */
export function logMissingSecretKey(env: NodeJS.ProcessEnv = process.env): void {
  try {
    parseSecretKey(env.KAKI_SECRET_KEY);
  } catch {
    console.error(
      `kaki workspace: tool logins are unavailable: ${SECRET_KEY_MISSING_MESSAGE}. ` +
        'Set KAKI_SECRET_KEY to 32 random bytes, base64-encoded.',
    );
  }
}

/** Encrypt one token with AES-256-GCM under the server key. */
export function encryptSecret(token: string, key: Buffer): EncryptedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const secret = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return { secret, iv, tag: cipher.getAuthTag(), keyId: keyIdOf(key) };
}

/** Decrypt one stored token, refusing a secret written under another key. */
export function decryptSecret(record: EncryptedSecret, key: Buffer): string {
  if (record.keyId !== keyIdOf(key)) {
    throw new SecretKeyError('wrong-key', SECRET_KEY_WRONG_MESSAGE);
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, record.iv);
    decipher.setAuthTag(record.tag);
    return Buffer.concat([decipher.update(record.secret), decipher.final()]).toString('utf8');
  } catch {
    throw new SecretKeyError('wrong-key', SECRET_KEY_WRONG_MESSAGE);
  }
}
