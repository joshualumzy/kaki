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
    'For each judgement you receive a numbered list of gold items and a numbered list of items the notetaker found.',
    'The gold decisions are background context only. Never pair a found item with a decision.',
    'Go through the gold list in order. For each gold item, give the number of the found item that describes the',
    'same concrete task or the same open question, or null when no found item does.',
    'Do not pair items merely because they share a topic, a person or a keyword.',
    'A found task covers a gold action only when doing the found task would itself get that action done. A card to',
    'post, send or announce a summary covers only a gold action about sharing that summary, not the work it lists.',
    'One found item may be named for several gold items when it really covers each of them (for example one card',
    '"email the minutes and the slides" covers two gold actions).',
    'Return one JSON object only, with exactly one entry per gold item, in gold order:',
    '{"matches":[{"gold":1,"found":2,"reason":"why these are the same"},{"gold":2,"found":null,"reason":"why nothing matches"}]}',
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

/**
 * The judge answers once per gold item, so every gold item is accounted for by shape; the code derives which found
 * items matched nothing (invented) instead of trusting the model with that bookkeeping.
 */
export function validateJudgeReply(text: string, foundCount: number, goldCount: number): JudgeSection {
  let json: unknown;
  try {
    json = parseJsonReply(text);
  } catch (error) {
    throw new Error(`judge reply is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isObject(json)) throw new Error('judge reply must be a JSON object');
  if (!Array.isArray(json.matches)) throw new Error('judge reply is missing its "matches" array');
  if (json.matches.length !== goldCount) {
    throw new Error(`judge reply has ${json.matches.length} matches for ${goldCount} gold items`);
  }

  const pairs: JudgePair[] = [];
  const unmatchedGold: number[] = [];
  json.matches.forEach((entry, index) => {
    const gold = index + 1;
    if (!isObject(entry)) throw new Error(`matches[${index}] must be an object`);
    if (entry.gold !== gold) throw new Error(`matches[${index}].gold must be ${gold} (one entry per gold item, in order)`);
    if (typeof entry.reason !== 'string' || entry.reason.trim() === '') {
      throw new Error(`matches[${index}].reason must be a non-empty string`);
    }
    if (entry.found === null) {
      unmatchedGold.push(gold);
      return;
    }
    if (!Number.isInteger(entry.found) || (entry.found as number) < 1 || (entry.found as number) > foundCount) {
      throw new Error(`matches[${index}].found must be null or an integer from 1 to ${foundCount}`);
    }
    pairs.push({ found: entry.found as number, gold, reason: entry.reason.trim() });
  });

  const pairedFound = new Set(pairs.map((pair) => pair.found));
  const unmatchedFound = Array.from({ length: foundCount }, (_, index) => index + 1).filter(
    (found) => !pairedFound.has(found),
  );
  return { pairs, unmatchedFound, unmatchedGold };
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
