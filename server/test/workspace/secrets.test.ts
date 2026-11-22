import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decryptSecret,
  encryptSecret,
  keyIdOf,
  parseSecretKey,
  SECRET_KEY_MISSING_MESSAGE,
  SECRET_KEY_WRONG_MESSAGE,
  SecretKeyError,
} from '../../src/workspace/secrets';

function key(): Buffer {
  return randomBytes(32);
}

describe('workspace tool secrets', () => {
  it('round-trips a token and records a key id', () => {
    const secretKey = key();
    const encrypted = encryptSecret('super-secret-token', secretKey);
    expect(encrypted.keyId).toBe(keyIdOf(secretKey));
    expect(encrypted.secret.toString('utf8')).not.toContain('super-secret-token');
    expect(decryptSecret(encrypted, secretKey)).toBe('super-secret-token');
  });

  it('refuses a token saved under another key with a reconnect message', () => {
    const encrypted = encryptSecret('token', key());
    try {
      decryptSecret(encrypted, key());
      throw new Error('expected a wrong-key failure');
    } catch (error) {
      expect(error).toBeInstanceOf(SecretKeyError);
      expect((error as SecretKeyError).problem).toBe('wrong-key');
      expect((error as Error).message).toBe(SECRET_KEY_WRONG_MESSAGE);
    }
  });

  it('fails with the setup message when the key is missing or not 32 bytes', () => {
    expect(() => parseSecretKey(undefined)).toThrowError(SECRET_KEY_MISSING_MESSAGE);
    expect(() => parseSecretKey('')).toThrowError(SECRET_KEY_MISSING_MESSAGE);
    expect(() => parseSecretKey(Buffer.from('short').toString('base64'))).toThrowError(
      SECRET_KEY_MISSING_MESSAGE,
    );
  });
});
