// Discard the saved meeting so the server starts with a clean screen next time.
// Run with: npm run meeting:reset
import '../env';
import { Pool } from 'pg';
import { ensureMeetingStateSchema } from './postgres';
import { MEETING_STATE_ID } from './state';

const connectionString = process.env.POSTGRES_URL?.trim();
if (connectionString === undefined || connectionString === '') {
  throw new Error('kaki persist: set POSTGRES_URL to the Postgres connection string, then run npm run meeting:reset.');
}

const pool = new Pool({ connectionString });
try {
  await ensureMeetingStateSchema(pool);
  const result = await pool.query<{ started_at: Date | string; saved_at: Date | string }>(
    'delete from meeting_state where id = $1 returning started_at, saved_at',
    [MEETING_STATE_ID],
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
