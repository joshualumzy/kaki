import { isObject } from '@kaki/shared';
import { parseJsonReply, type ChatMessage, type LlmClient } from '../../services/llm';

export interface JudgePair {
  found: number;
  gold: number;
  reason: string;
}

export interface JudgeSection {
  pairs: JudgePair[];
  unmatchedFound: number[];
  unmatchedGold: number[];
}

export interface JudgeVerdict {
  tasks: JudgeSection;
  questions: JudgeSection;
}

export interface JudgeInput {
  meeting: string;
  foundTasks: string[];
  foundQuestions: string[];
  goldActions: string[];
  goldProblems: string[];
  goldDecisions: string[];
}

type JudgeKind = 'tasks' | 'questions';

interface SectionInput {
  meeting: string;
  kind: JudgeKind;
  found: string[];
  gold: string[];
  decisions: string[];
}

function numbered(items: string[]): string {
  return items.length === 0 ? '(none)' : items.map((item, index) => `${index + 1}. ${item}`).join('\n');
}

function systemPrompt(): string {
  return [
    'You are scoring a meeting notetaker against a gold answer key from the AMI Meeting Corpus.',
    'For each judgement you receive a numbered list of items the notetaker found and a numbered list of gold items.',
    'The gold decisions are background context only. Never pair a found item with a decision.',
    'Pair a found item with a gold item only when they describe the same concrete task or the same open question.',
    'Do not pair items merely because they share a topic, a person or a keyword.',
    'One gold item may match at most one found item. One found item may match several gold items when it really',
    'covers each of them (for example one card "email the minutes and the slides" covers two gold actions).',
    'Every gold index must appear exactly once, in a pair or in unmatchedGold. Every found index must appear in at',
    'least one pair or in unmatchedFound, never both.',
    'Use 1-based indices. Return one JSON object only, in exactly this shape:',
    '{"pairs":[{"found":1,"gold":2,"reason":"why these are the same"}],"unmatchedFound":[3],"unmatchedGold":[4]}',
    'Use empty arrays when there is nothing to list.',
  ].join('\n');
}

function userPrompt(input: SectionInput): string {
  const kindLabel = input.kind === 'tasks' ? 'follow-up tasks' : 'open questions';
  const goldLabel = input.kind === 'tasks' ? 'gold actions' : 'gold problems';
  return [
    `Meeting: ${input.meeting}`,
    `Judgement: found ${kindLabel} against ${goldLabel}.`,
    '',
    'Gold decisions (context only; never match an item to these):',
    numbered(input.decisions),
    '',
    `${goldLabel} (gold list):`,
    numbered(input.gold),
    '',
    `Found ${kindLabel} (found list):`,
    numbered(input.found),
    '',
    'Return the JSON object now.',
  ].join('\n');
}

function indices(value: unknown, label: string, limit: number): number[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry, index) => {
    if (!Number.isInteger(entry) || (entry as number) < 1 || (entry as number) > limit) {
      throw new Error(`${label}[${index}] must be an integer from 1 to ${limit}`);
    }
    return entry as number;
  });
}

export function validateJudgeReply(text: string, foundCount: number, goldCount: number): JudgeSection {
  let json: unknown;
  try {
    json = parseJsonReply(text);
  } catch (error) {
    throw new Error(`judge reply is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isObject(json)) throw new Error('judge reply must be a JSON object');
  if (!Array.isArray(json.pairs)) throw new Error('judge reply is missing its "pairs" array');

  const pairs = json.pairs.map((entry, index): JudgePair => {
    if (!isObject(entry)) throw new Error(`pairs[${index}] must be an object`);
    if (!Number.isInteger(entry.found) || (entry.found as number) < 1 || (entry.found as number) > foundCount) {
      throw new Error(`pairs[${index}].found must be an integer from 1 to ${foundCount}`);
    }
    if (!Number.isInteger(entry.gold) || (entry.gold as number) < 1 || (entry.gold as number) > goldCount) {
      throw new Error(`pairs[${index}].gold must be an integer from 1 to ${goldCount}`);
    }
    if (typeof entry.reason !== 'string' || entry.reason.trim() === '') {
      throw new Error(`pairs[${index}].reason must be a non-empty string`);
    }
    return { found: entry.found as number, gold: entry.gold as number, reason: entry.reason.trim() };
  });

  const unmatchedFound = indices(json.unmatchedFound, 'unmatchedFound', foundCount);
  const unmatchedGold = indices(json.unmatchedGold, 'unmatchedGold', goldCount);

  const seenFound = new Set<number>();
  const seenGold = new Set<number>();
  const claimFound = (index: number, where: string) => {
    if (seenFound.has(index)) throw new Error(`found index ${index} appears more than once (${where})`);
    seenFound.add(index);
  };
  const claimGold = (index: number, where: string) => {
    if (seenGold.has(index)) throw new Error(`gold index ${index} appears more than once (${where})`);
    seenGold.add(index);
  };

  // A found item may cover several gold items, so it may repeat across pairs; each gold item is matched once.
  const pairedFound = new Set(pairs.map((pair) => pair.found));
  for (const found of pairedFound) claimFound(found, 'pairs');
  for (const [index, pair] of pairs.entries()) claimGold(pair.gold, `pairs[${index}]`);
  for (const [index, found] of unmatchedFound.entries()) claimFound(found, `unmatchedFound[${index}]`);
  for (const [index, gold] of unmatchedGold.entries()) claimGold(gold, `unmatchedGold[${index}]`);

  if (seenFound.size !== foundCount) {
    throw new Error(`judge reply accounts for ${seenFound.size} of ${foundCount} found items`);
  }
  if (seenGold.size !== goldCount) {
    throw new Error(`judge reply accounts for ${seenGold.size} of ${goldCount} gold items`);
  }

  return {
    pairs,
    unmatchedFound: [...unmatchedFound].sort((left, right) => left - right),
    unmatchedGold: [...unmatchedGold].sort((left, right) => left - right),
  };
}

async function judgeSection(llm: LlmClient, input: SectionInput): Promise<JudgeSection> {
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt() },
    { role: 'user', content: userPrompt(input) },
  ];
  const first = await llm.complete(messages, { json: true });
  try {
    return validateJudgeReply(first, input.found.length, input.gold.length);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const retryMessages: ChatMessage[] = [
      ...messages,
      { role: 'assistant', content: first },
      { role: 'user', content: `That reply was rejected: ${reason}. Return only the JSON object in the required shape.` },
    ];
    const second = await llm.complete(retryMessages, { json: true });
    try {
      return validateJudgeReply(second, input.found.length, input.gold.length);
    } catch (retryError) {
      const retryReason = retryError instanceof Error ? retryError.message : String(retryError);
      throw new Error(
        `AMI judge for ${input.kind} in ${input.meeting} returned an unusable reply twice: ${retryReason}`,
        { cause: retryError },
      );
    }
  }
}

export async function judgeAmi(llm: LlmClient, input: JudgeInput): Promise<JudgeVerdict> {
  const tasks = await judgeSection(llm, {
    meeting: input.meeting,
    kind: 'tasks',
    found: input.foundTasks,
    gold: input.goldActions,
    decisions: input.goldDecisions,
  });
  const questions = await judgeSection(llm, {
    meeting: input.meeting,
    kind: 'questions',
    found: input.foundQuestions,
    gold: input.goldProblems,
    decisions: input.goldDecisions,
  });
  return { tasks, questions };
}
