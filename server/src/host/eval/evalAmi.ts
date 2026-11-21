import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isObject, type KakiEvent, type Scenario, type Task } from '@kaki/shared';
import type { Hub } from '../../core/hub';
import { loadScenario, scenarioDir } from '../../core/loadScenario';
import { createTaskStore } from '../../meeting/tasks';
import { notetakerLlmFromEnv, type LlmClient } from '../../services/llm';
import { createNotetaker } from '../notetaker';
import { parseReplay, type ReplayLine } from '../replay';
import { AMI_MEETINGS } from './convertAmi';
import { judgeAmi, type JudgePair } from './judgeAmi';

const LOG_DIR = fileURLToPath(new URL('../../../../.live-logs/', import.meta.url));

interface AmiGold {
  actions: string[];
  decisions: string[];
  problems: string[];
}

interface AmiFixture {
  meeting: string;
  source: string;
  lines: ReplayLine[];
  gold: AmiGold;
}

interface SectionScore {
  found: string[];
  gold: string[];
  pairs: JudgePair[];
  unmatchedFound: number[];
  unmatchedGold: number[];
  caught: number;
  missed: number;
  invented: number;
  recall: number;
  precision: number;
}

interface RunResult {
  meeting: string;
  run: number;
  passes: number;
  durationSeconds: number;
  notetakerStatus: string;
  tasks: SectionScore;
  questions: SectionScore;
}

interface SummarySection {
  caught: number;
  missed: number;
  invented: number;
  recall: number;
  precision: number;
}

interface SummaryRow {
  meeting: string;
  runs: number;
  tasks: SummarySection;
  questions: SummarySection;
}

const silentHub: Hub = {
  publish: (_event: KakiEvent) => {},
  subscribe: () => () => {},
  onCommand: () => {},
  clearRetained: () => {},
  close: () => {},
};

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.trim() !== '')) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  return value;
}

function ratio(part: number, whole: number): number {
  return whole === 0 ? 1 : part / whole;
}

function scoreSection(found: string[], gold: string[], section: { pairs: JudgePair[]; unmatchedFound: number[]; unmatchedGold: number[] }): SectionScore {
  // Each gold item is paired at most once; one found item may cover several gold items.
  const caught = section.pairs.length;
  const matchedFound = new Set(section.pairs.map((pair) => pair.found)).size;
  return {
    found,
    gold,
    pairs: section.pairs,
    unmatchedFound: section.unmatchedFound,
    unmatchedGold: section.unmatchedGold,
    caught,
    missed: section.unmatchedGold.length,
    invented: section.unmatchedFound.length,
    recall: ratio(caught, gold.length),
    precision: ratio(matchedFound, found.length),
  };
}

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function formatTask(task: Task): string {
  const title = clean(task.title);
  const context = clean(task.context);
  return context.length === 0
    ? `${title} (owner: ${task.suggestedAssignee})`
    : `${title} — ${context} (owner: ${task.suggestedAssignee})`;
}

async function loadMeeting(scenario: Scenario, meeting: string): Promise<AmiFixture> {
  const file = path.join(scenarioDir('ami-eval'), 'meetings', `${meeting}.json`);
  let json: unknown;
  try {
    json = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read AMI fixture ${file}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  if (!isObject(json)) throw new Error(`AMI fixture ${file} must be a JSON object`);
  if (json.meeting !== meeting) throw new Error(`AMI fixture ${file} is for "${String(json.meeting)}", not "${meeting}"`);
  if (typeof json.source !== 'string' || json.source.trim() === '') {
    throw new Error(`AMI fixture ${file} has no source`);
  }
  if (!isObject(json.gold)) throw new Error(`AMI fixture ${file} has no gold object`);
  const lines = parseReplay({ lines: json.lines }, scenario);
  if (lines.length === 0) throw new Error(`AMI fixture ${file} has no lines`);
  return {
    meeting,
    source: json.source,
    lines,
    gold: {
      actions: stringArray(json.gold.actions, `${file} gold.actions`),
      decisions: stringArray(json.gold.decisions, `${file} gold.decisions`),
      problems: stringArray(json.gold.problems, `${file} gold.problems`),
    },
  };
}

async function runOnce(
  scenario: Scenario,
  fixture: AmiFixture,
  llm: LlmClient,
  run: number,
  windowSeconds: number,
): Promise<RunResult> {
  const tasks = createTaskStore({ hub: silentHub, scenario });
  let agendaIndex = 0;
  const notetaker = createNotetaker({ scenario: () => scenario, tasks, llm, agendaIndex: () => agendaIndex });
  const started = Date.now();
  let passes = 0;

  for (let from = 0; from <= fixture.lines.at(-1)!.at; from += windowSeconds) {
    const batch = fixture.lines.filter((line) => line.at >= from && line.at < from + windowSeconds);
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
  await notetaker.run();

  const state = notetaker.state();
  const foundTasks = tasks.list().map(formatTask);
  const foundQuestions = state.openQuestions.map((question) => {
    const text = clean(question.text);
    return question.forRole === undefined ? text : `${text} (for: ${question.forRole})`;
  });
  const verdict = await judgeAmi(llm, {
    meeting: fixture.meeting,
    foundTasks,
    foundQuestions,
    goldActions: fixture.gold.actions,
    goldProblems: fixture.gold.problems,
    goldDecisions: fixture.gold.decisions,
  });

  return {
    meeting: fixture.meeting,
    run,
    passes,
    durationSeconds: Math.round(((Date.now() - started) / 1000) * 10) / 10,
    notetakerStatus: state.status,
    tasks: scoreSection(foundTasks, fixture.gold.actions, verdict.tasks),
    questions: scoreSection(foundQuestions, fixture.gold.problems, verdict.questions),
  };
}

function itemAt(items: string[], index: number): string {
  return items.at(index - 1) ?? `(missing item ${index})`;
}

function printSection(label: string, section: SectionScore): void {
  console.log(
    `${label}: caught ${section.caught}, missed ${section.missed}, invented ${section.invented} ` +
      `(gold ${section.gold.length}, found ${section.found.length})`,
  );
  for (const pair of section.pairs) {
    console.log(
      `  PAIR found ${pair.found} "${itemAt(section.found, pair.found)}" <> ` +
        `gold ${pair.gold} "${itemAt(section.gold, pair.gold)}": ${pair.reason}`,
    );
  }
  for (const index of section.unmatchedGold) console.log(`  MISSED gold ${index}: ${itemAt(section.gold, index)}`);
  for (const index of section.unmatchedFound) console.log(`  INVENTED found ${index}: ${itemAt(section.found, index)}`);
}

function printRun(result: RunResult): void {
  console.log(`\n=== ${result.meeting} — run ${result.run} ===`);
  console.log(`passes ${result.passes}, notetaker ${result.notetakerStatus}, ${result.durationSeconds} s`);
  printSection('Tasks', result.tasks);
  printSection('Questions', result.questions);
}

function summarizeSections(sections: SectionScore[], runs: number): SummarySection {
  const caught = sections.reduce((total, section) => total + section.caught, 0);
  const missed = sections.reduce((total, section) => total + section.missed, 0);
  const invented = sections.reduce((total, section) => total + section.invented, 0);
  const gold = sections.reduce((total, section) => total + section.gold.length, 0);
  const found = sections.reduce((total, section) => total + section.found.length, 0);
  return {
    caught: caught / runs,
    missed: missed / runs,
    invented: invented / runs,
    recall: ratio(caught, gold),
    // One found item may cover several gold items, so precision counts found items that matched anything.
    precision: ratio(found - invented, found),
  };
}

function summarize(results: RunResult[], meetings: string[]): SummaryRow[] {
  const rows: SummaryRow[] = meetings.map((meeting) => {
    const meetingResults = results.filter((result) => result.meeting === meeting);
    const meetingRuns = meetingResults.length;
    return {
      meeting,
      runs: meetingRuns,
      tasks: summarizeSections(meetingResults.map((result) => result.tasks), meetingRuns),
      questions: summarizeSections(meetingResults.map((result) => result.questions), meetingRuns),
    };
  });
  rows.push({
    meeting: 'TOTAL',
    runs: results.length,
    tasks: summarizeSections(results.map((result) => result.tasks), results.length),
    questions: summarizeSections(results.map((result) => result.questions), results.length),
  });
  return rows;
}

function fixed(value: number): string {
  return value.toFixed(2);
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function printSummary(rows: SummaryRow[]): void {
  console.log('\nFinal table (counts averaged over runs; recall = caught/gold, precision = found items that matched / found)');
  console.table(
    rows.map((row) => ({
      Meeting: row.meeting,
      Runs: row.runs,
      'Tasks caught': fixed(row.tasks.caught),
      'Tasks missed': fixed(row.tasks.missed),
      'Tasks invented': fixed(row.tasks.invented),
      'Tasks recall': percent(row.tasks.recall),
      'Tasks precision': percent(row.tasks.precision),
      'Questions caught': fixed(row.questions.caught),
      'Questions missed': fixed(row.questions.missed),
      'Questions invented': fixed(row.questions.invented),
      'Questions recall': percent(row.questions.recall),
      'Questions precision': percent(row.questions.precision),
    })),
  );
}

async function writeResults(
  scenario: Scenario,
  results: RunResult[],
  summary: SummaryRow[],
  meetings: string[],
  runs: number,
  windowSeconds: number,
): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(LOG_DIR, `ami-eval-${timestamp}.json`);
  await mkdir(LOG_DIR, { recursive: true });
  await writeFile(
    file,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        source: 'AMI Meeting Corpus, CC BY 4.0',
        scenario: scenario.id,
        windowSeconds,
        runs,
        meetings,
        results,
        summary,
      },
      null,
      2,
    )}\n`,
  );
  return file;
}

function runsFrom(raw: string | undefined): number {
  const value = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error('--runs must be a positive integer');
  return value;
}

export function parseAmiArgs(argv: string[]): { meetings: string[]; runs: number } {
  const known = new Set<string>(AMI_MEETINGS);
  const selected = new Set<string>();
  let runs = 2;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === '--ami') continue;
    if (argument === '--runs') {
      runs = runsFrom(argv[++index]);
      continue;
    }
    if (argument.startsWith('--runs=')) {
      runs = runsFrom(argument.slice('--runs='.length));
      continue;
    }
    if (argument === '--meeting') {
      const meeting = argv[++index];
      if (meeting === undefined) throw new Error('--meeting needs a meeting name');
      if (!known.has(meeting)) throw new Error(`Unknown meeting "${meeting}"; choose from ${[...known].join(', ')}`);
      selected.add(meeting);
      continue;
    }
    if (argument.startsWith('--meeting=')) {
      const meeting = argument.slice('--meeting='.length);
      if (!known.has(meeting)) throw new Error(`Unknown meeting "${meeting}"; choose from ${[...known].join(', ')}`);
      selected.add(meeting);
      continue;
    }
    throw new Error(`Unknown argument "${argument}"`);
  }

  return { meetings: selected.size === 0 ? [...AMI_MEETINGS] : [...selected], runs };
}

export async function runAmiEval(argv: string[]): Promise<void> {
  const { meetings, runs } = parseAmiArgs(argv);
  const llm = notetakerLlmFromEnv();
  if (llm === undefined) {
    console.error('Set KAKI_LLM_BASE_URL, KAKI_LLM_API_KEY and KAKI_LLM_MODEL (in .env or the shell) first.');
    process.exitCode = 2;
    return;
  }

  const rawWindow = Number(process.env.EVAL_WINDOW_SECONDS ?? 70);
  if (!Number.isFinite(rawWindow) || rawWindow <= 0) {
    throw new Error(`EVAL_WINDOW_SECONDS must be a positive number, got "${process.env.EVAL_WINDOW_SECONDS}"`);
  }
  const windowSeconds = rawWindow;

  const scenario = await loadScenario('ami-eval');
  const fixtures = new Map<string, AmiFixture>();
  for (const meeting of meetings) fixtures.set(meeting, await loadMeeting(scenario, meeting));

  const results: RunResult[] = [];
  for (const meeting of meetings) {
    for (let run = 1; run <= runs; run += 1) {
      const result = await runOnce(scenario, fixtures.get(meeting)!, llm, run, windowSeconds);
      results.push(result);
      printRun(result);
    }
  }

  const summary = summarize(results, meetings);
  printSummary(summary);

  const file = await writeResults(scenario, results, summary, meetings, runs, windowSeconds);
  console.log(`\nWrote ${file}`);
}
