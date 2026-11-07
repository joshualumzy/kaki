import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as readline from 'node:readline';
import {
  isKakiEvent,
  isSuggestInput,
  parseScenario,
  type KakiEvent,
  type SuggestInput,
} from '@kaki/shared';

const port = process.env.PORT ?? '3001';
const folder = process.env.SCENARIO ?? 'kopitiam';
const scenariosDir = fileURLToPath(new URL('../scenarios/', import.meta.url));
const folderPattern = /^[a-z0-9][a-z0-9-]*$/;

async function readJson(file: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    throw new Error(`Could not read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function describeAudience(audience: KakiEvent['audience']): string {
  if (audience.kind === 'role') return `role:${audience.role}`;
  return audience.kind;
}

async function post(pathname: string, body: unknown): Promise<Response> {
  return fetch(`http://localhost:${port}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function promptEnter(message: string): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(message, () => {
      rl.close();
      resolve();
    });
  });
}

if (!folderPattern.test(folder)) {
  throw new Error(`Invalid SCENARIO "${folder}": expected a folder name such as "kopitiam"`);
}

const scenarioDir = path.join(scenariosDir, folder);
const scenario = parseScenario(await readJson(path.join(scenarioDir, 'scenario.json')));
const demo = await readJson(path.join(scenarioDir, 'demo-events.json'));

if (typeof demo !== 'object' || demo === null || Array.isArray(demo)) {
  throw new Error('demo-events.json must be an object with "events" and "tasks" arrays');
}
const { events, tasks } = demo as { events?: unknown; tasks?: unknown };
if (!Array.isArray(events) || !Array.isArray(tasks)) {
  throw new Error('demo-events.json must be an object with "events" and "tasks" arrays');
}

const validEvents: KakiEvent[] = [];
events.forEach((event, index) => {
  if (!isKakiEvent(event, scenario)) {
    throw new Error(`demo-events.json: events[${index}] is not a valid KakiEvent for scenario "${scenario.id}"`);
  }
  validEvents.push(event);
});

const validTasks: SuggestInput[] = [];
tasks.forEach((task, index) => {
  if (!isSuggestInput(task, scenario)) {
    throw new Error(`demo-events.json: tasks[${index}] is not a valid task suggestion for "${scenario.id}"`);
  }
  validTasks.push(task);
});

// Create a combined list of actions to step through interactively
const actions = [
  ...validEvents.map(e => ({ type: 'event', data: e })),
  ...validTasks.map(t => ({ type: 'task', data: t }))
];

console.log(`Loaded ${validEvents.length} events and ${validTasks.length} tasks for scenario "${scenario.id}".`);
console.log(`Press Enter to step through each action sequentially...\n`);

for (const action of actions) {
  if (action.type === 'event') {
    const event = action.data as KakiEvent;
    await promptEnter(`Press Enter to emit event: ${event.type} -> ${describeAudience(event.audience)} ...`);
    const response = await post('/dev/emit', event);
    if (!response.ok) {
      throw new Error(`POST /dev/emit failed for ${event.type} (${response.status}): ${await response.text()}`);
    }
    console.log(`✔ sent ${event.type}\n`);
  } else {
    const task = action.data as SuggestInput;
    await promptEnter(`Press Enter to suggest task: "${task.title}" -> role:${task.suggestedAssignee} ...`);
    const response = await post('/dev/suggest-task', task);
    if (!response.ok) {
      throw new Error(`POST /dev/suggest-task failed for "${task.title}" (${response.status}): ${await response.text()}`);
    }
    console.log(`✔ suggested task "${task.title}"\n`);
  }
}

console.log(`Finished sending all scripted moments!`);
