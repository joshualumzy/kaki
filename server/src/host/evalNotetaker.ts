/**
 * Run the scenario's replay through the notetaker with the real LLM and compare the result with
 * replay/expected.json. For tuning the prompt; needs KAKI_LLM_* (from .env or the shell).
 *
 *   npm run eval:notetaker            # EVAL_WINDOW_SECONDS=70 meeting seconds per pass (7 s at 10x)
 */
import '../env';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { KakiEvent, Role } from '@kaki/shared';
import type { Hub } from '../core/hub';
import { notetakerLlmFromEnv } from '../services/llm';
import { loadScenario, scenarioDir, scenarioFolder } from '../core/loadScenario';
import { createTaskStore } from '../meeting/tasks';
import { createNotetaker } from './notetaker';
import { loadReplay } from './replay';
import {
  judgeNotetaker,
  notetakerFailures,
  type ExpectedNotetakerItems,
} from './eval/judgeNotetaker';

if (process.argv.includes('--ami')) {
  const { runAmiEval } = await import('./eval/evalAmi');
  await runAmiEval(process.argv.slice(2));
  process.exit(process.exitCode ?? 0);
}

interface Expected extends ExpectedNotetakerItems {
  quietRoles: Role[];
}

const silentHub: Hub = {
  publish: (_event: KakiEvent) => {},
  subscribe: () => () => {},
  onCommand: () => {},
  clearRetained: () => {},
  close: () => {},
};

const llm = notetakerLlmFromEnv();
if (llm === undefined) {
  console.error('Set KAKI_LLM_BASE_URL, KAKI_LLM_API_KEY and KAKI_LLM_MODEL (in .env or the shell) first.');
  process.exit(2);
}

const windowSeconds = Number(process.env.EVAL_WINDOW_SECONDS ?? 70);
const folder = scenarioFolder();
const scenario = await loadScenario(folder);
const lines = await loadReplay(scenario, folder);
const expected = JSON.parse(
  await readFile(path.join(scenarioDir(folder), 'replay', 'expected.json'), 'utf8'),
) as Expected;

const tasks = createTaskStore({ hub: silentHub, scenario });
let agendaIndex = 0;
const notetaker = createNotetaker({ scenario: () => scenario, tasks, llm, agendaIndex: () => agendaIndex });

const started = Date.now();
let passes = 0;
for (let from = 0; from <= lines.at(-1)!.at; from += windowSeconds) {
  const batch = lines.filter((line) => line.at >= from && line.at < from + windowSeconds);
  if (batch.length === 0) continue;
  for (const line of batch) {
    agendaIndex = line.agendaIndex ?? agendaIndex;
    notetaker.addChunk(line);
  }
  await notetaker.run();
  passes += 1;
  const { status, lastError } = notetaker.state();
  if (status === 'stale') console.warn(`  pass ${passes} failed: ${lastError}`);
}
// Retry anything a failed pass left behind.
await notetaker.run();

const state = notetaker.state();
const found = tasks.list();
console.log(`\n${passes} passes in ${((Date.now() - started) / 1000).toFixed(1)} s, notetaker ${state.status}\n`);
console.log(`Tasks (${found.length}):`);
for (const task of found) console.log(`  - ${task.title} → ${task.suggestedAssignee} ${task.actionKind ?? '(manual)'}`);
console.log(`Open questions (${state.openQuestions.length}):`);
for (const question of state.openQuestions) console.log(`  - ${question.text} → ${question.forRole ?? '?'}`);
console.log(`Quiet roles: ${state.quietRoles.join(', ') || '(none)'}\n`);

const foundTasks = found.map((task) => ({
  title: task.title,
  context: task.context,
  suggestedAssignee: task.suggestedAssignee,
}));
const foundQuestions = state.openQuestions.map((question) => ({
  text: question.text,
  ...(question.forRole === undefined ? {} : { forRole: question.forRole }),
}));

// Meaning decides a match: the model compares the found items with replay/expected.json, not words or keywords.
console.log('Judging the found items against the expected items by meaning...');
const verdict = await judgeNotetaker(llm, {
  meeting: scenario.meetingTitle,
  foundTasks,
  foundQuestions,
  expected,
});

const failures = notetakerFailures(expected, { tasks: foundTasks }, verdict);
for (const role of expected.quietRoles) {
  if (!state.quietRoles.includes(role)) failures.push(`not flagged as quiet: ${role}`);
}

if (failures.length === 0) {
  console.log('PASS');
} else {
  console.log(`FAIL\n${failures.map((failure) => `  - ${failure}`).join('\n')}`);
  process.exitCode = 1;
}
