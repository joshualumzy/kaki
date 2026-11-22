import type { LlmClient } from '../../services/llm';
import { judgeSection, type JudgeSection } from './judgeAmi';

/** One task in scenarios/<scenario>/replay/expected.json. Its keywords are deliberately unused: meaning decides. */
export interface ExpectedTask {
  name: string;
  assignee: string;
}

/** One open question in the expected answer key. */
export interface ExpectedQuestion {
  name: string;
}

/** The expected items for the scenario's replay. */
export interface ExpectedNotetakerItems {
  tasks: ExpectedTask[];
  acceptedTasks?: ExpectedTask[];
  questions: ExpectedQuestion[];
}

/** A task the notetaker actually found. */
export interface FoundTask {
  title: string;
  context: string;
  suggestedAssignee: string;
}

/** A question the notetaker actually left open. */
export interface FoundQuestion {
  text: string;
  forRole?: string;
}

export interface NotetakerJudgeInput {
  meeting: string;
  foundTasks: FoundTask[];
  foundQuestions: FoundQuestion[];
  expected: ExpectedNotetakerItems;
}

export interface NotetakerJudgeVerdict {
  /** One entry per expected task (required, then accepted) and per found task. */
  tasks: JudgeSection;
  questions: JudgeSection;
}

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function expectedTaskText(task: ExpectedTask): string {
  return `${clean(task.name)} (owner: ${task.assignee})`;
}

function foundTaskText(task: FoundTask): string {
  const context = clean(task.context);
  return `${clean(task.title)}${context === '' ? '' : ` — ${context}`} (owner: ${task.suggestedAssignee})`;
}

function foundQuestionText(question: FoundQuestion): string {
  const text = clean(question.text);
  return question.forRole === undefined ? text : `${text} (for: ${question.forRole})`;
}

/**
 * Judge the notetaker's found tasks and questions against the expected answer key by meaning. The found and expected
 * items are numbered plain text; the model pairs them, so no keyword or word-overlap test decides a match.
 */
export async function judgeNotetaker(
  llm: LlmClient,
  input: NotetakerJudgeInput,
): Promise<NotetakerJudgeVerdict> {
  const expectedTasks = [...input.expected.tasks, ...(input.expected.acceptedTasks ?? [])].map(expectedTaskText);
  const [tasks, questions] = await Promise.all([
    judgeSection(llm, {
      meeting: input.meeting,
      kind: 'tasks',
      found: input.foundTasks.map(foundTaskText),
      gold: expectedTasks,
      decisions: [],
    }),
    judgeSection(llm, {
      meeting: input.meeting,
      kind: 'questions',
      found: input.foundQuestions.map(foundQuestionText),
      gold: input.expected.questions.map((question) => clean(question.name)),
      decisions: [],
    }),
  ]);
  return { tasks, questions };
}

/**
 * Turn the judge's pairings into the run's failures. Accepted tasks are optional, so only a missing required task
 * fails; a found task paired with nothing is an unexpected task. A matching found task is never inferred from words.
 */
export function notetakerFailures(
  expected: ExpectedNotetakerItems,
  found: { tasks: FoundTask[] },
  verdict: NotetakerJudgeVerdict,
): string[] {
  const failures: string[] = [];
  for (const gold of verdict.tasks.unmatchedGold) {
    const required = expected.tasks[gold - 1];
    if (required !== undefined) failures.push(`missing task: ${required.name}`);
  }
  for (const index of verdict.tasks.unmatchedFound) {
    failures.push(`unexpected task: ${found.tasks[index - 1]?.title ?? `found item ${index}`}`);
  }
  for (const gold of verdict.questions.unmatchedGold) {
    failures.push(`missing question: ${expected.questions[gold - 1]?.name ?? `expected item ${gold}`}`);
  }
  return failures;
}
