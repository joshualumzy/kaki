// Must stay the first import: later modules read process.env as they load.
import './env';
import { actionModules, calendarFromEnv, logMissingActionConfig } from './action';
import { createApp } from './app';
import { createAuthFromEnv } from './auth/module';
import { createHostModules } from './host';
import { loadScenario } from './loadScenario';
import { createMeetingPersistenceFromEnv } from './persist/persistence';
import { wingmanModules } from './wingman';

logMissingActionConfig();

const rawPort = process.env.PORT ?? '3001';
const port = Number(rawPort);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid PORT: ${rawPort}`);
}

const scenario = await loadScenario();
const persistence = await createMeetingPersistenceFromEnv();
const host = createHostModules(scenario);
const authEnabled = process.env.KAKI_AUTH === '1';
const auth = authEnabled
  ? await createAuthFromEnv({ roles: scenario.roles.map((role) => role.id) })
  : undefined;

try {
  await createApp({
    port,
    scenario,
    modules: [...host.modules, ...wingmanModules, ...actionModules],
    devRoutes: process.env.KAKI_DEV_ROUTES !== '0',
    auth,
    calendar: calendarFromEnv(),
    draftOnly: process.env.KAKI_DRAFT_ONLY === '1',
    meetingElapsedSeconds: host.meetingElapsedSeconds,
    persistence,
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
