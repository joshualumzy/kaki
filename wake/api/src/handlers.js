import { ConfigError, loadConfig } from './config.js';
import { AzureError, createAzureClient } from './azure.js';

const STARTABLE = new Set(['deallocated', 'stopped']);
const SWITCHING_OFF = new Set(['deallocating', 'stopping']);

/** What the page should say about Kaki, from the VM's power and the app's health. */
export function appState(power, healthy) {
  if (power === 'running') return healthy ? 'ready' : 'unhealthy';
  if (power === 'starting') return 'starting';
  if (STARTABLE.has(power)) return 'off';
  if (SWITCHING_OFF.has(power)) return 'switching-off';
  return 'unknown';
}

function errorResult(status, message) {
  return { status, jsonBody: { error: message } };
}

function reasonFor(error) {
  if (error instanceof AzureError) return error.message;
  if (error instanceof Error && error.message) return `Unexpected error: ${error.message}`;
  return 'Unexpected error.';
}

export async function statusHandler(env = process.env, deps = {}) {
  let config;
  try {
    config = loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return errorResult(500, error.message);
    throw error;
  }

  const client = createAzureClient(config, deps);
  try {
    const power = await client.getPower();
    const healthy = power === 'running' ? await client.isHealthy() : false;
    return { status: 200, jsonBody: { power, healthy, state: appState(power, healthy) } };
  } catch (error) {
    return errorResult(502, reasonFor(error));
  }
}

export async function wakeHandler(env = process.env, deps = {}) {
  let config;
  try {
    config = loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return errorResult(500, error.message);
    throw error;
  }

  const client = createAzureClient(config, deps);
  try {
    const power = await client.getPower();
    if (power === 'running' || power === 'starting') {
      return { status: 200, jsonBody: { started: false, power } };
    }
    if (SWITCHING_OFF.has(power)) {
      return errorResult(409, 'Kaki is switching off; try again in a minute');
    }
    if (!STARTABLE.has(power)) {
      return errorResult(409, `Kaki is in an unexpected power state (${power}); try again in a minute`);
    }
    await client.start();
    return { status: 200, jsonBody: { started: true } };
  } catch (error) {
    return errorResult(502, reasonFor(error));
  }
}
