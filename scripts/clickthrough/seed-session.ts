// TEST-ONLY helper for the click-through: makes a Google-style user plus a live session straight in the
// database and prints the session token. It is a script, not a server route, so the running server has
// no login bypass. Usage: npx tsx scripts/clickthrough/seed-session.ts <name> <email>
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { SESSION_TTL_MS } from '../../server/src/auth/cookie';
import { hashToken } from '../../server/src/auth/password';
import { createPostgresAuthStore } from '../../server/src/auth/postgres';
import { ensureAuthSchema } from '../../server/src/auth/schema';

const [name, email] = process.argv.slice(2);
const url = process.env.POSTGRES_URL?.trim();
if (!name || !email || !url) {
  console.error('Usage: POSTGRES_URL=... npx tsx scripts/clickthrough/seed-session.ts <name> <email>');
  process.exit(1);
}
const pool = new Pool({ connectionString: url });
await ensureAuthSchema(pool);
const store = createPostgresAuthStore(pool);
const user =
  (await store.findUserByGoogleSub(`clickthrough-${email}`)) ??
  (await store.createGoogleUser({ googleSub: `clickthrough-${email}`, name, email }));
const token = randomBytes(32).toString('base64url');
await store.createSession({
  tokenHash: hashToken(token),
  kind: 'user',
  role: null,
  meetingCode: null,
  meetingId: null,
  displayName: name,
  userId: user.id,
  expiresAt: new Date(Date.now() + SESSION_TTL_MS),
});
await pool.end();
console.log(JSON.stringify({ token, userId: user.id }));
