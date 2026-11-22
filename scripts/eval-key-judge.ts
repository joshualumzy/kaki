/** Judge an AI-guest live playtest report against the judge-only answer key. */
import '../server/src/env';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createOpenAiLlm, LlmError, reasoningControlFromEnv, type ChatMessage } from '../server/src/services/llm';
import {
  evidenceForTopic, judgePrompt, parseAnswerKey, parseJudgeReply, parseReport, prepareTopic,
  renderTotals, renderVerdict, scoreTopic, summarizeVerdicts, type AnswerKey, type TopicVerdict,
} from './eval-key';

type Options = { report: string; key: string; emptyWorkspace: boolean };

function parseOptions(argv: readonly string[]): Options {
  let report: string | undefined;
  let key = 'scenarios/kopitiam/eval/answer-key.json';
  let emptyWorkspace = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--key') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error('--key needs a path');
      key = next;
      i += 1;
    } else if (arg === '--empty-workspace') {
      emptyWorkspace = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown argument: ${arg}`);
    } else if (report === undefined) {
      report = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  if (report === undefined) {
    throw new Error('Usage: npm run eval:key -- <playtest-report.md> [--key scenarios/kopitiam/eval/answer-key.json] [--empty-workspace]');
  }
  return { report, key, emptyWorkspace };
}

function errorText(error: unknown): string {
  if (error instanceof LlmError) {
    const status = /HTTP \d{3}/.exec(error.message)?.[0];
    return status === undefined ? 'the judge model request failed or timed out' : `the judge model request failed with ${status}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function judgeModel(): ReturnType<typeof createOpenAiLlm> {
  const env = process.env;
  const missing = ['KAKI_LLM_FALLBACK_BASE_URL', 'KAKI_LLM_FALLBACK_API_KEY', 'KAKI_LLM_FALLBACK_MODEL'].filter((name) => !env[name]);
  if (missing.length > 0) throw new Error(`Missing eval judge configuration: ${missing.join(', ')}`);
  return createOpenAiLlm({
    baseUrl: env.KAKI_LLM_FALLBACK_BASE_URL!,
    apiKey: env.KAKI_LLM_FALLBACK_API_KEY!,
    model: env.KAKI_LLM_FALLBACK_MODEL!,
    reasoningControl: reasoningControlFromEnv(env.KAKI_LLM_FALLBACK_REASONING_CONTROL, 'KAKI_LLM_FALLBACK_REASONING_CONTROL'),
  });
}

function knownTopics(key: AnswerKey, reportTopics: ReadonlySet<string>): string[] {
  return key.topics.map((topic) => topic.title).filter((title) => reportTopics.has(title));
}

function reportTopicTitles(report: ReturnType<typeof parseReport>): Set<string> {
  const titles = new Set<string>();
  const add = (title: string): void => {
    if (title !== '' && title !== 'unknown topic' && title !== '(no agenda item)') titles.add(title);
  };
  for (const line of report.transcript) add(line.topic);
  for (const note of report.wingmanNotes) add(note.topic);
  for (const decision of report.decisions) add(decision.topic);
  for (const todo of report.todos) add(todo.topic);
  return titles;
}

/** Read one report, make one judge call per played topic, print the scores and write the JSON beside the report. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseOptions(argv);
  const [markdown, keyText] = await Promise.all([readFile(options.report, 'utf8'), readFile(options.key, 'utf8')]);
  let keyValue: unknown;
  try {
    keyValue = JSON.parse(keyText);
  } catch {
    throw new Error(`${options.key} is not valid JSON`);
  }
  const key = parseAnswerKey(keyValue);
  const report = parseReport(markdown);
  const titles = reportTopicTitles(report);
  const unknown = [...titles].filter((title) => !key.topics.some((topic) => topic.title === title));
  if (unknown.length > 0) throw new Error(`Report has topic(s) not in the answer key: ${unknown.join(' | ')}`);
  const played = knownTopics(key, titles);
  if (played.length === 0) {
    throw new Error('Report has no agenda-topic transcript, Wingman notes or notetaker output to judge');
  }
  const skipped = key.topics.map((topic) => topic.title).filter((title) => !titles.has(title));
  const judge = judgeModel();
  const verdicts: TopicVerdict[] = [];
  for (const title of played) {
    const topic = key.topics.find((entry) => entry.title === title)!;
    const prepared = prepareTopic(topic, evidenceForTopic(report, title), options.emptyWorkspace);
    const messages: ChatMessage[] = judgePrompt(prepared, options.emptyWorkspace);
    let reply: string;
    try {
      reply = await judge.complete(messages, { json: true, temperature: 0, maxTokens: 1600 });
    } catch (error) {
      throw new Error(`Judge call failed for "${title}": ${errorText(error)}`);
    }
    if (reply.trim() === '') throw new Error(`Judge returned an empty reply for "${title}"`);
    let raw: ReturnType<typeof parseJudgeReply>;
    try {
      raw = parseJudgeReply(reply, prepared);
    } catch (error) {
      throw new Error(`Judge reply for "${title}" was unusable: ${errorText(error)}`);
    }
    verdicts.push(scoreTopic(prepared, raw, options.emptyWorkspace));
  }
  const totals = summarizeVerdicts(verdicts);
  const output = [
    `# Answer-key eval — ${options.report}`,
    '',
    `Key: ${options.key} · Empty workspace: ${options.emptyWorkspace ? 'yes' : 'no'} · Topics judged: ${played.length}`,
    ...(skipped.length === 0 ? [] : ['', `Not played (not scored): ${skipped.join(' | ')}`]),
    '',
    ...verdicts.flatMap((verdict) => renderVerdict(verdict)),
    ...renderTotals(totals),
  ];
  for (const line of output) console.log(line);
  const jsonPath = join(dirname(options.report), `${basename(options.report, '.md')}-eval.json`);
  await writeFile(jsonPath, JSON.stringify({
    report: options.report,
    key: options.key,
    emptyWorkspace: options.emptyWorkspace,
    generatedAt: new Date().toISOString(),
    topics: verdicts,
    totals,
    skippedTopics: skipped,
    unlabelled: {
      decisions: report.decisions.filter((decision) => decision.topic === '(no agenda item)').length,
      todos: report.todos.filter((todo) => todo.topic === '(no agenda item)').length,
    },
  }, null, 2));
  console.log('');
  console.log(`Eval JSON: ${jsonPath}`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
