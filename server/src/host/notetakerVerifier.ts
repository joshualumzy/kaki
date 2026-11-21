import { isObject, isRoleIn, type Role, type Scenario } from '@kaki/shared';
import { parseJsonReply, type ChatMessage, type LlmClient } from '../services/llm';
import type { AnswerCandidate } from './notetakerQuestions';
import type { ResolvedTaskCandidate } from './notetakerTasks';

/** The verifier's judgement of one candidate: supported, not supported, or not decidable from the line. */
export type Verdict = 'yes' | 'no' | 'unclear';
/** The verifier's verdict for one task and the role it says owns the work. */
export interface TaskVerdict {
  verdict: Verdict;
  assigneeRole: Role | null;
}

/** The verifier's verdicts for all answer and task candidates, plus the issues it could not decide. */
export interface VerifierResult {
  answers: Map<string, Verdict>;
  tasks: Map<number, TaskVerdict>;
  /** Specific issues for candidates the verifier could not decide. */
  issues: string[];
}
const VERIFIER_MARKER = '[KAKI_SEMANTIC_VERIFIER]';

function isVerdict(value: unknown): value is Verdict {
  return value === 'yes' || value === 'no' || value === 'unclear';
}

function verifierMessages(
  scenario: Scenario,
  answers: AnswerCandidate[],
  tasks: ResolvedTaskCandidate[],
): ChatMessage[] {
  const roles = scenario.roles.map((role) => `- ${role.id}: ${role.label}`);
  const system = [
    VERIFIER_MARKER,
    'You check meeting evidence by meaning, not word overlap.',
    'For each exact question/quote pair, judge meaning rather than word overlap. Answer "yes" only when the line gives the requested fact without material uncertainty. Return "no" for unrelated, hypothetical, deferred, or different information; "unclear" when evidence is insufficient.',
    'For each deliverable/quote pair, answer "yes" only when the line assigns that same after-meeting deliverable to its owner, asks that named person to do it (for example "Ben, can you email the supplier?"), or the owner volunteers for it. The card is a suggestion the owner can still accept or decline, so a direct request counts. Return "no" for unrelated, hypothetical, deferred, or different work, or a request to nobody in particular; "unclear" when evidence is insufficient.',
    'Roles (use the id on the left):',
    ...roles,
    'Reply with one JSON object only.',
    'Shape: {"answers":[{"id":"q-1","verdict":"yes|no|unclear"}],"tasks":[{"index":0,"verdict":"yes|no|unclear","assigneeRole":"role-id" or null}]}.',
    'Include exactly one entry for every candidate under judgement. assigneeRole must name the role of the person who will do the work: for a request, the person who was asked (by name or role), never the speaker who asked. Check the suggested owner against the quote and correct it when the quote names someone else.',
  ].join('\n');
  const user = [
    'Questions to judge:',
    ...(answers.length === 0
      ? ['(none)']
      : answers.map((answer) => `- ${answer.id}: ${answer.question.text}\n  Quote: "${answer.source.text}"`)),
    'Deliverables to judge:',
    ...(tasks.length === 0
      ? ['(none)']
      : tasks.map((candidate) => {
          const action = candidate.task.actionKind === undefined ? '' : ` (${candidate.task.actionKind})`;
          return `- index ${candidate.index}: ${candidate.task.title} — ${candidate.task.context}${action}\n  Quote (${candidate.source.speaker ?? 'unknown'}): "${candidate.source.text}"\n  Suggested owner (verify it): ${candidate.task.suggestedAssignee}`;
        })),
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** Parse the verifier's reply, requiring exactly one typed verdict for every candidate. */
function parseVerifierReply(
  text: string,
  answers: AnswerCandidate[],
  tasks: ResolvedTaskCandidate[],
  scenario: Scenario,
): { answers: Map<string, Verdict>; tasks: Map<number, TaskVerdict> } | undefined {
  let json: unknown;
  try {
    json = parseJsonReply(text);
  } catch {
    return undefined;
  }
  if (!isObject(json) || !Array.isArray(json.answers) || !Array.isArray(json.tasks)) return undefined;

  const answerVerdicts = new Map<string, Verdict>();
  for (const entry of json.answers) {
    if (!isObject(entry) || typeof entry.id !== 'string' || !isVerdict(entry.verdict)) return undefined;
    if (!answers.some((candidate) => candidate.id === entry.id)) return undefined;
    if (answerVerdicts.has(entry.id)) return undefined;
    answerVerdicts.set(entry.id, entry.verdict);
  }
  if (answerVerdicts.size !== answers.length) return undefined;

  const taskVerdicts = new Map<number, TaskVerdict>();
  for (const entry of json.tasks) {
    if (!isObject(entry) || !Number.isInteger(entry.index) || !isVerdict(entry.verdict)) return undefined;
    const index = entry.index as number;
    if (!tasks.some((candidate) => candidate.index === index)) return undefined;
    if (taskVerdicts.has(index)) return undefined;
    if (entry.verdict === 'yes' && !isRoleIn(scenario, entry.assigneeRole)) return undefined;
    const assigneeRole = isRoleIn(scenario, entry.assigneeRole) ? entry.assigneeRole : null;
    taskVerdicts.set(index, { verdict: entry.verdict, assigneeRole });
  }
  if (taskVerdicts.size !== tasks.length) return undefined;
  return { answers: answerVerdicts, tasks: taskVerdicts };
}

/**
 * One batched, meaning-based judgement for every grounded candidate in this pass. A failed call or unreadable
 * reply is retried once; if both fail it throws, so the caller keeps the batch pending for the next tick instead of
 * treating a transport problem as a model verdict. Only a parsed `unclear` verdict is the model's own judgement.
 */
export async function verifyCandidates(
  verifier: LlmClient,
  scenario: Scenario,
  answers: AnswerCandidate[],
  tasks: ResolvedTaskCandidate[],
  log: (message: string) => void,
): Promise<VerifierResult> {
  if (answers.length === 0 && tasks.length === 0) {
    return { answers: new Map(), tasks: new Map(), issues: [] };
  }
  const messages = verifierMessages(scenario, answers, tasks);
  let lastFailure: string | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const reply = await verifier.complete(messages, { json: true, temperature: 0 });
      const parsed = parseVerifierReply(reply, answers, tasks, scenario);
      if (parsed !== undefined) return { ...parsed, issues: [] };
      lastFailure = 'its reply could not be read';
      log(`could not read the semantic verifier reply (attempt ${attempt + 1})`);
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
      log(`the semantic verifier failed (attempt ${attempt + 1}): ${lastFailure}`);
    }
  }
  throw new Error(
    `the semantic verifier could not judge this batch after 2 attempts (${lastFailure ?? 'no reason given'})`,
  );
}
