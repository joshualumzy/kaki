// Must stay the first import: later modules read process.env as they load.
import './env';
import { createActionModules, calendarFromEnv, logMissingActionConfig } from './action';
import { createApp } from './app';
import { createAuthFromEnv } from './auth/module';
import { createHostModules } from './host';
import { loadScenario } from './core/loadScenario';
import { createMeetingCodeSource } from './meeting/meetingCode';
import { createMeetingPersistenceFromEnv } from './persist/persistence';
import { Pool } from 'pg';
import { ensureMeetingsSchema, ensureWorkspaceToolsSchema } from './auth/schema';
import { createPostgresMeetingStore, type MeetingStore } from './meeting/registry';
import type { MeetingPersistence } from './persist/persistence';
import { createWingmanModules } from './wingman';
import { logMissingSecretKey } from './workspace/secrets';
import { createPostgresWorkspaceToolStore, type WorkspaceToolStore } from './workspace/tools';

logMissingActionConfig();
logMissingSecretKey();

const rawPort = process.env.PORT ?? '3001';
const port = Number(rawPort);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid PORT: ${rawPort}`);
}

const bindHost = process.env.KAKI_BIND?.trim() || '0.0.0.0';
const scenario = await loadScenario();
const persistence = await createMeetingPersistenceFromEnv();
const postgresUrl = process.env.POSTGRES_URL?.trim();
let meetings: MeetingStore | undefined;
let persistenceFor: ((id: string) => Promise<MeetingPersistence | undefined>) | undefined;
let meetingsPool: Pool | undefined;
let workspaceTools: WorkspaceToolStore | undefined;
if (postgresUrl !== undefined && postgresUrl !== '') {
  meetingsPool = new Pool({ connectionString: postgresUrl });
  meetingsPool.on('error', (error) => console.error('kaki meetings: database error', error));
  await ensureMeetingsSchema(meetingsPool);
  await ensureWorkspaceToolsSchema(meetingsPool);
  workspaceTools = createPostgresWorkspaceToolStore(meetingsPool);
  const store = createPostgresMeetingStore(meetingsPool);
  meetings = {
    ...store,
    async close() {
      if (meetingsPool !== undefined) await meetingsPool.end();
    },
  };
  persistenceFor = (id: string) => createMeetingPersistenceFromEnv({ id });
}
const host = createHostModules(scenario);
const meetingCode = createMeetingCodeSource();
const authEnabled = process.env.KAKI_AUTH === '1';
const auth = authEnabled ? await createAuthFromEnv({ meetingCode }) : undefined;

let app: Awaited<ReturnType<typeof createApp>>;
try {
  app = await createApp({
    port,
    host: bindHost,
    scenario,
    modules: [...host.modules, ...createWingmanModules(), ...createActionModules()],
    devRoutes: process.env.KAKI_DEV_ROUTES === '1',
    auth,
    calendar: calendarFromEnv(),
    draftOnly: process.env.KAKI_DRAFT_ONLY === '1',
    meetingElapsedSeconds: host.meetingElapsedSeconds,
    meetingAgendaIndex: host.meetingAgendaIndex,
    meetingPaused: host.meetingPaused,
    meetingPause: host.meetingPause,
    persistence,
    meetingCode,
    ...(meetings === undefined ? {} : { meetings }),
    ...(workspaceTools === undefined ? {} : { workspaceTools }),
    ...(persistenceFor === undefined ? {} : { persistenceFor }),
  });
} catch (error) {
  await auth?.close().catch(() => undefined);
  await persistence?.close().catch(() => undefined);
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
