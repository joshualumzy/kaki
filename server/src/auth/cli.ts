import { stdin, stdout } from 'node:process';
import { Pool } from 'pg';
import { hashPassword } from './password';
import { createPostgresAuthStore } from './postgres';
import { ensureAuthSchema } from './schema';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_PASSWORD_LENGTH = 1024;

function readPipedPassword(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';

    const finish = (value: string): void => {
      stdin.off('data', onData);
      stdin.off('end', onEnd);
      stdin.pause();
      resolve(value);
    };

    const onData = (chunk: string): void => {
      data += chunk;
      const newline = data.search(/\r?\n/);
      if (newline !== -1) finish(data.slice(0, newline));
    };

    const onEnd = (): void => finish(data.replace(/\r?\n$/, ''));

    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    stdin.on('end', onEnd);
    stdin.on('error', reject);
    stdin.resume();
  });
}

/** Read one line from the terminal without echoing it. */
function readPassword(prompt: string): Promise<string> {
  if (typeof stdin.setRawMode !== 'function') {
    return readPipedPassword();
  }

  stdout.write(prompt);
  return new Promise((resolve, reject) => {
    stdin.setRawMode?.(true);
    stdin.setEncoding('utf8');
    stdin.resume();

    let value = '';

    const cleanup = (): void => {
      stdin.off('data', onData);
      stdin.setRawMode?.(false);
      stdin.pause();
    };

    const onData = (chunk: string): void => {
      for (const character of chunk) {
        if (character === '\r' || character === '\n') {
          cleanup();
          stdout.write('\n');
          resolve(value);
          return;
        }
        if (character === '\u0003') {
          cleanup();
          stdout.write('\n');
          reject(new Error('Cancelled.'));
          return;
        }
        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= ' ') value += character;
      }
    };

    stdin.on('data', onData);
  });
}

async function main(): Promise<void> {
  const rawEmail = process.argv[2];
  if (rawEmail === undefined || rawEmail.trim() === '') {
    throw new Error('Usage: npm run host:create -- <email>');
  }

  const email = rawEmail.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email)) {
    throw new Error(`"${rawEmail}" is not a valid email address.`);
  }

  const connectionString = process.env.POSTGRES_URL?.trim();
  if (connectionString === undefined || connectionString === '') {
    throw new Error('Set POSTGRES_URL to the Postgres connection string.');
  }

  const password = await readPassword('Password: ');
  if (password.trim() === '') {
    throw new Error('The password cannot be empty.');
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new Error('The password is too long.');
  }

  const pool = new Pool({ connectionString });
  try {
    await ensureAuthSchema(pool);
    const store = createPostgresAuthStore(pool);

    if (await store.findUserByEmail(email)) {
      throw new Error(`A host account with ${email} already exists; passwords are never overwritten.`);
    }

    await store.createUser({ email, passwordHash: await hashPassword(password) });
    console.log(`Created the host account ${email}.`);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

try {
  await main();
} catch (error) {
  console.error(`kaki host:create: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
