import { createApp } from './app';
import { devModules } from './dev';
import { hostModules } from './host';
import { loadScenario } from './loadScenario';
import { wingmanModules } from './wingman';

const rawPort = process.env.PORT ?? '3001';
const port = Number(rawPort);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid PORT: ${rawPort}`);
}

const scenario = await loadScenario();
await createApp({
  port,
  scenario,
  modules: [...hostModules, ...wingmanModules, ...devModules],
});
console.log(`kaki server listening on http://localhost:${port} (scenario: ${scenario.id})`);
