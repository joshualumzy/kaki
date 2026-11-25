// Must stay the first import: later modules read process.env as they load.
import './env';
import { calendarFromEnv, logMissingActionConfig } from './action';
import { createApp } from './app';
import { createAuthFromEnv } from './auth/module';
import { loadScenario } from './core/loadScenario';
import { createMeetingPersistenceFromEnv } from './persist/persistence';
import { Pool } from 'pg';
import { ensureMeetingsSchema, ensureWorkspaceToolsSchema } from './auth/schema';
import { createPostgresMeetingStore, type MeetingStore } from './meeting/registry';
import type { MeetingPersistence } from './persist/persistence';
import { logMissingSecretKey } from './workspace/secrets';
import { createPostgresWorkspaceToolStore, type WorkspaceToolStore } from './workspace/tools';
import { createPostgresAccountDataDeletion } from './account/deleteAccountData';
import { createPostgresWorkspaceDataDeletion } from './workspace/deleteWorkspaceData';
import { createPostgresCalendarCancellationStore } from './meeting/calendarCancellations';
import { createPostgresTaskCalendarEventStore } from './meeting/taskCalendarEvents';

logMissingActionConfig();
logMissingSecretKey();

const rawPort = process.env.PORT ?? '3001';
const port = Number(rawPort);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid PORT: ${rawPort}`);
}

const bindHost = process.env.KAKI_BIND?.trim() || '0.0.0.0';
const scenario = await loadScenario();
const postgresUrl = process.env.POSTGRES_URL?.trim();
let meetings: MeetingStore | undefined;
let findSavedIdByCode: ((code: string) => Promise<string | undefined>) | undefined;
let persistenceFor: ((id: string) => Promise<MeetingPersistence | undefined>) | undefined;
let meetingsPool: Pool | undefined;
let workspaceTools: WorkspaceToolStore | undefined;
let calendarCancellations: ReturnType<typeof createPostgresCalendarCancellationStore> | undefined;
let taskCalendarEvents: ReturnType<typeof createPostgresTaskCalendarEventStore> | undefined;
if (postgresUrl !== undefined && postgresUrl !== '') {
  meetingsPool = new Pool({ connectionString: postgresUrl });
  meetingsPool.on('error', (error) => console.error('kaki meetings: database error', error));
  await ensureMeetingsSchema(meetingsPool);
  await ensureWorkspaceToolsSchema(meetingsPool);
  workspaceTools = createPostgresWorkspaceToolStore(meetingsPool);
  calendarCancellations = createPostgresCalendarCancellationStore(meetingsPool);
  taskCalendarEvents = createPostgresTaskCalendarEventStore(meetingsPool);
  const store = createPostgresMeetingStore(meetingsPool);
  meetings = {
    ...store,
    async close() {
      if (meetingsPool !== undefined) await meetingsPool.end();
    },
  };
  persistenceFor = (id: string) => createMeetingPersistenceFromEnv({ id });
  const codePool = meetingsPool;
  findSavedIdByCode = async (code: string) => {
    const result = await codePool.query<{ id: string }>(
      'select id from meeting_state where meeting_code = $1 limit 1',
      [code],
    );
    return result.rows[0]?.id;
  };
}
const authEnabled = process.env.KAKI_AUTH === '1';
const auth = authEnabled ? await createAuthFromEnv() : undefined;
const accountDeletion =
  auth !== undefined &&
  meetings !== undefined &&
  workspaceTools !== undefined &&
  meetingsPool !== undefined
    ? createPostgresAccountDataDeletion({
        pool: meetingsPool,
        auth: auth.store,
        meetings,
        tools: workspaceTools,
      })
    : undefined;
const workspaceDeletion =
  auth !== undefined &&
  meetings !== undefined &&
  workspaceTools !== undefined &&
  meetingsPool !== undefined
    ? createPostgresWorkspaceDataDeletion({
        pool: meetingsPool,
        auth: auth.store,
        meetings,
        tools: workspaceTools,
      })
    : undefined;

let app: Awaited<ReturnType<typeof createApp>>;
try {
  app = await createApp({
    port,
    host: bindHost,
    scenario,
    devRoutes: process.env.KAKI_DEV_ROUTES === '1',
    auth,
    calendar: calendarFromEnv(),
    draftOnly: process.env.KAKI_DRAFT_ONLY === '1',
    ...(meetings === undefined ? {} : { meetings }),
    ...(workspaceTools === undefined ? {} : { workspaceTools }),
    ...(calendarCancellations === undefined ? {} : { calendarCancellations }),
    ...(taskCalendarEvents === undefined ? {} : { taskCalendarEvents }),
    ...(accountDeletion === undefined ? {} : { accountDeletion }),
    ...(workspaceDeletion === undefined ? {} : { workspaceDeletion }),
    ...(persistenceFor === undefined ? {} : { persistenceFor }),
    ...(findSavedIdByCode === undefined ? {} : { findSavedIdByCode }),
  });
} catch (error) {
  await auth?.close().catch(() => undefined);
  await meetingsPool?.end().catch(() => undefined);
  throw error;
}

console.log(
  `kaki server listening on http://localhost:${port} (scenario: ${scenario.id}, auth: ${
    authEnabled ? 'on' : 'off'
  })`,
);

let stopping = false;
/** Save the meeting (bounded) and close the server, so `npm stop` never loses the last changes. */
async function stop(signal: NodeJS.Signals): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`kaki server: ${signal} received; saving the meeting and stopping`);
  const timer = setTimeout(() => {
    console.error('kaki server: saving the meeting took more than 3 s; stopping anyway');
    process.exit(1);
  }, 3_000);
  try {
    await app.close();
  } catch (error) {
    console.error('kaki server: stopping failed', error);
  }
  clearTimeout(timer);
  process.exit(0);
}
process.on('SIGINT', () => void stop('SIGINT'));
process.on('SIGTERM', () => void stop('SIGTERM'));
