/**
 * How the plain scripted robot answers the room: one model call judges whether the newest room lines
 * need the guest at all, and writes the short line if they do. The regex choices below are only the
 * logged backstop for a failed call, never the way a meaning is guessed.
 */
import { createOpenAiLlm, LlmError, parseJsonReply, reasoningControlFromEnv, type ChatMessage, type LlmClient } from '../server/src/llm';
import type { Scenario } from '@kaki/shared';
import type { Line } from './live-playtest';
import { guestIdentity, topicContext, transcriptText } from './visitor-context';

type RoomReplyKind = 'confirm' | 'answer' | 'accept-offer' | 'decline-offer' | 'draft-yes' | 'none';

/** The model's decision for one batch of fresh room lines. A null reply means the guest stays quiet. */
interface RoomReply {
  reply: string | null;
  kind: RoomReplyKind;
}

export type RoomReplyModel = Pick<LlmClient, 'complete'>;

export interface RoomReplyRequest {
  scenario: Scenario;
  role: string;
  topicTitle: string;
  transcript: readonly Line[];
  /** The guest's fixed call on this topic, or undefined on the tabling topic where it has asked to table and made none. */
  decision?: string;
  /** The room lines heard since the guest's own last line, oldest first. */
  fresh: readonly Line[];
  hostName: string;
  /** How many lines the guest has already said on this topic, for the canned backstop. */
  robotLineCount: number;
}

export interface RoomReplyOutcome extends RoomReply {
  /** Set when the model failed and the logged canned backstop supplied the reply. */
  warning?: string;
}

const KINDS: readonly RoomReplyKind[] = ['confirm', 'answer', 'accept-offer', 'decline-offer', 'draft-yes', 'none'];

/** A model reply that cannot be used, named without echoing anything the model wrote. */
class RoomReplyError extends Error {}

function fixedCall(request: RoomReplyRequest): string {
  return request.decision === undefined
    ? 'On this topic you asked the room to table it, and you have no call of your own yet.'
    : `Your fixed call on this topic, already made in the meeting: "${request.decision}".`;
}

function freshText(lines: readonly Line[]): string {
  return lines.map((line) => `${line.speaker}: ${line.text}`).join('\n') || '(no new room lines)';
}

/** The messages for the scripted robot's single reply decision. */
export function roomReplyPrompt(request: RoomReplyRequest): ChatMessage[] {
  const topic = topicContext(request.scenario, request.role, request.topicTitle);
  return [
    {
      role: 'system',
      content: [
        guestIdentity(request.scenario, request.role),
        'You are taking part in a live meeting as the guest; your words are typed into the meeting as your next spoken line.',
        fixedCall(request),
        '',
        'Decide whether the guest should answer the newest room lines, and if so, what the guest says. Return only JSON:',
        '{"reply":"<one short spoken sentence>" or null,"kind":"confirm" | "answer" | "accept-offer" | "decline-offer" | "draft-yes" | "none"}',
        'Use null and "none" when the newest lines are not for the guest or need no reply.',
        '',
        'Rules:',
        '- Stay consistent with the fixed call. Never contradict it, replace it, or promise more than it says.',
        '- When the host raises a catch or cost that the fixed call leaves open, give a short concrete answer in one sentence, using only facts the guest seat has heard in the transcript or holds on its seat card. Do not invent numbers, names, times or promises.',
        '- A question that asks for the guest\'s view or checks their call needs a short answer; a line that is not for the guest, or that colleagues are still answering, needs no reply.',
        '- On the tabling topic you have no call yet: when the host puts one concrete call to you, accept it if it is sensible ("accept-offer"); decline only if it clearly conflicts with what your seat knows. If the host only asks for your view, give the smallest sensible call in one sentence ("answer").',
        '- When the host offers to draft, send, post or email something, say yes ("draft-yes").',
        '- Never repeat a line already in the transcript. Never mention the card, the screen, this request or the JSON.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `Current topic: ${request.topicTitle}`,
        `Briefing: ${topic.briefing}`,
        `Decision at hand: ${topic.decision}`,
        `Your seat's known fact: ${topic.seatFact}`,
        `The newest room lines since your last line, oldest first:\n${freshText(request.fresh)}`,
        `Meeting transcript so far:\n${transcriptText(request.transcript)}`,
      ].join('\n'),
    },
  ];
}

function cleanReply(text: string): string {
  return text.trim().replace(/^['"“”]+|['"“”]+$/g, '').replace(/\s+/g, ' ').trim();
}

/** Parse and validate one model reply; anything unusable throws so the caller can log and fall back. */
export function parseRoomReply(text: string): RoomReply {
  let value: unknown;
  try {
    value = parseJsonReply(text);
  } catch {
    throw new RoomReplyError('the model reply was not valid JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RoomReplyError('the model reply was not a JSON object');
  }
  const data = value as Record<string, unknown>;
  if (typeof data.kind !== 'string' || !KINDS.includes(data.kind as RoomReplyKind)) {
    throw new RoomReplyError('the model reply had no usable kind');
  }
  const kind = data.kind as RoomReplyKind;
  if (kind === 'none' || data.reply === null) return { reply: null, kind: 'none' };
  if (typeof data.reply !== 'string') throw new RoomReplyError('the model reply had no usable line');
  const reply = cleanReply(data.reply);
  if (reply.length === 0 || /[\r\n]/.test(reply) || reply.length > 240) {
    throw new RoomReplyError('the model reply was not one short line');
  }
  return { reply, kind };
}

function isActionRequest(text: string): boolean {
  return /(?:can|could|would|will)\s+you\b[^?]*\b(?:post|email|send|schedule|confirm|draft|share|set\s+up|put\s+(?:that|this)\s+in)\b/i.test(text) ||
    /^(?:please\s+)?(?:post|email|send|schedule|confirm)\b/i.test(text);
}

function reasonFor(title: string): string {
  const name = title.toLowerCase();
  if (name.includes('counter staff')) return 'it covers the counter without spending more than the rush is worth.';
  if (name.includes('regulars')) return 'it keeps the old regulars while the new menu pays its way.';
  if (name.includes('laptop')) return 'it frees breakfast seats without putting staff in a confrontation.';
  if (name.includes('food safety')) return 'it keeps us straight with the officer and the customer.';
  if (name.includes('delivery')) return 'it protects margin while keeping the office orders.';
  throw new Error(`No scenario reason prepared for: ${title}`);
}

/**
 * The old word-matching choice, kept only as a logged backstop when the model call fails. It uses the
 * same caps and wording the scripted run used before, so one failed call cannot stop a topic settling.
 */
export function cannedRoomReply(request: RoomReplyRequest): RoomReply {
  for (const [position, line] of request.fresh.entries()) {
    const before = request.fresh[position - 1];
    const asked = before !== undefined && before.speaker === line.speaker ? `${before.text} ${line.text}` : line.text;
    const isLatest = position === request.fresh.length - 1;
    const latestQuestion = isLatest && /\?\s*$/.test(line.text.trim()) && /robot visitor/i.test(asked);
    const hostQuestion = isLatest && /\?\s*$/.test(line.text.trim()) && line.speaker === request.hostName;
    const readBack = hostQuestion && request.decision !== undefined && request.robotLineCount > 0;
    const hostOffer = hostQuestion && request.decision === undefined && request.robotLineCount > 0;
    if (/\brecap\b/i.test(line.text)) {
      return { reply: `No need, here's my call: ${request.decision ?? "let's table it and settle it in the follow-up."}`, kind: 'answer' };
    }
    if (isActionRequest(line.text)) return { reply: 'Yes, please draft that for me.', kind: 'draft-yes' };
    if (readBack) return { reply: "Yes, that's my call.", kind: 'confirm' };
    if (hostOffer) return { reply: "Yes, let's go with that.", kind: 'accept-offer' };
    if (latestQuestion) {
      return {
        reply: request.decision === undefined ? "Let's settle that in the follow-up." : `My call stands: ${reasonFor(request.topicTitle)}`,
        kind: 'answer',
      };
    }
  }
  return { reply: null, kind: 'none' };
}

function failureWarning(request: RoomReplyRequest, error: unknown): string {
  const line = request.fresh.at(-1);
  const kind = error instanceof LlmError
    ? 'model request failed'
    : error instanceof RoomReplyError
      ? error.message
      : 'model call failed';
  return `Model room-reply failed for "${line?.text ?? '(no line)'}" (${kind}); used the logged canned line`;
}

/** One model call for a batch of fresh room lines; on failure the canned backstop answers instead. */
export async function decideRoomReply(request: RoomReplyRequest, model: RoomReplyModel): Promise<RoomReplyOutcome> {
  try {
    const raw = await model.complete(roomReplyPrompt(request), { json: true, temperature: 0.4, maxTokens: 200, reasoningEffort: 'none' });
    return parseRoomReply(raw);
  } catch (error) {
    return { ...cannedRoomReply(request), warning: failureWarning(request, error) };
  }
}

/** The same LLM configuration the AI visitor uses, built once by the CLI entry. */
export function roomReplyModelFromEnv(env: NodeJS.ProcessEnv = process.env): RoomReplyModel {
  const baseUrl = env.KAKI_LLM_BASE_URL;
  const apiKey = env.KAKI_LLM_API_KEY;
  const model = env.KAKI_LLM_MODEL;
  // Without a model the robot cannot judge what the room says, so the run would not test anything real.
  if (!baseUrl || !apiKey || !model) throw new Error('The playtest robot needs KAKI_LLM_BASE_URL, KAKI_LLM_API_KEY and KAKI_LLM_MODEL to read the room');
  return createOpenAiLlm({
    baseUrl,
    apiKey,
    model,
    reasoningControl: reasoningControlFromEnv(env.KAKI_LLM_REASONING_CONTROL, 'KAKI_LLM_REASONING_CONTROL'),
  });
}
