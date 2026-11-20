// Must stay the first import: later modules read process.env as they load.
import './env';
import { humanSeatRoles } from '@kaki/shared';
import { actionModules, calendarFromEnv, logMissingActionConfig } from './action';
import { createApp } from './app';
import { createAuthFromEnv } from './auth/module';
import { createHostModules } from './host';
import { loadScenario } from './loadScenario';
import { createMeetingCodeSource } from './meetingCode';
import { createMeetingPersistenceFromEnv } from './persist/persistence';
import { wingmanModules } from './wingman';

logMissingActionConfig();

const rawPort = process.env.PORT ?? '3001';
const port = Number(rawPort);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid PORT: ${rawPort}`);
}

const bindHost = process.env.KAKI_BIND?.trim() || '0.0.0.0';
const scenario = await loadScenario();
const persistence = await createMeetingPersistenceFromEnv();
const host = createHostModules(scenario);
const meetingCode = createMeetingCodeSource();
const authEnabled = process.env.KAKI_AUTH === '1';
const auth = authEnabled
  ? await createAuthFromEnv({
      roles: humanSeatRoles(scenario).map((role) => role.id),
      meetingCode,
    })
  : undefined;

let app: Awaited<ReturnType<typeof createApp>>;
try {
  app = await createApp({
    port,
    host: bindHost,
    scenario,
    modules: [...host.modules, ...wingmanModules, ...actionModules],
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
  });
} catch (error) {
  await auth?.close().catch(() => undefined);
  await persistence?.close().catch(() => undefined);
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
