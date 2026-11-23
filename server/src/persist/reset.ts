// Discard the saved meeting so the server starts with a clean screen next time.
// Run with: npm run meeting:reset -- <meetingId>
import '../env';
import { Pool } from 'pg';
import { ensureMeetingStateSchema } from './postgres';

// The meeting row to discard, named by the meeting whose saved state it is.
const meetingId = process.argv[2]?.trim();
if (meetingId === undefined || meetingId === '') {
  throw new Error('kaki persist: name the meeting whose saved state to discard: npm run meeting:reset -- <meetingId>');
}

const connectionString = process.env.POSTGRES_URL?.trim();
if (connectionString === undefined || connectionString === '') {
  throw new Error(
    'kaki persist: POSTGRES_URL is not set. Set it in the shell, in the repo .env, or in docker/.env ' +
      '(npm run seed writes it there), then run npm run meeting:reset -- <meetingId>.',
  );
}

const pool = new Pool({ connectionString });
try {
  await ensureMeetingStateSchema(pool);
  const result = await pool.query<{ started_at: Date | string; saved_at: Date | string }>(
    'delete from meeting_state where id = $1 returning started_at, saved_at',
    [meetingId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    console.log('kaki persist: no saved meeting to delete');
  } else {
    console.log(
      `kaki persist: deleted the saved meeting that started at ${new Date(row.started_at).toISOString()} ` +
        `(saved at ${new Date(row.saved_at).toISOString()})`,
    );
  }
} finally {
  await pool.end();
}
