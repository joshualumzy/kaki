/**
 * The plain scripted robot's opening call on a topic: one model call reads the guest's seat card and
 * what the room has said so far, and writes the call in the guest's own words. The title-specific
 * lines below are only the logged backstop for a failed call, never the decision itself.
 */
import { LlmError, parseJsonReply, type ChatMessage, type LlmClient } from '../server/src/llm';
import type { Scenario } from '@kaki/shared';
import type { Line } from './live-playtest';
import { guestIdentity, topicContext, transcriptText } from './visitor-context';

type RobotDecisionModel = Pick<LlmClient, 'complete'>;

export interface RobotDecisionRequest {
  scenario: Scenario;
  role: string;
  topicTitle: string;
  /** Everything heard before the guest makes this call. */
  transcript: readonly Line[];
}

interface RobotDecisionOutcome {
  call: string;
  /** Set when the model failed and the logged canned call stood in. */
  warning?: string;
}

class RobotDecisionError extends Error {}

/** The messages for the scripted robot's one call on a topic. */
export function robotDecisionPrompt(request: RobotDecisionRequest): ChatMessage[] {
  const topic = topicContext(request.scenario, request.role, request.topicTitle);
  return [
    {
      role: 'system',
      content: [
        guestIdentity(request.scenario, request.role),
        'You are taking part in a live meeting as the guest. Make your opening-day call on the current topic, in your own words, as one short spoken line.',
        'Return only JSON: {"call":"<one short spoken sentence>"}',
        '',
        'Rules:',
        '- Take one clear position that follows from your seat card, the briefing and the room so far. Do not sit on the fence.',
        '- Use only facts your seat holds or that were said in the transcript. Do not invent numbers, names, times or promises.',
        '- Do not mention the card, the screen, this request or the JSON. No speaker label, quotation marks or stage directions.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `Current topic: ${request.topicTitle}`,
        `Briefing: ${topic.briefing}`,
        `Decision at hand: ${topic.decision}`,
        `Your seat's known fact: ${topic.seatFact}`,
        `Meeting transcript so far:\n${transcriptText(request.transcript)}`,
      ].join('\n'),
    },
  ];
}

/** Parse and validate one model call; anything unusable throws so the caller can log and fall back. */
export function parseRobotDecision(text: string): string {
  let value: unknown;
  try {
    value = parseJsonReply(text);
  } catch {
    throw new RobotDecisionError('the model reply was not valid JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RobotDecisionError('the model reply was not a JSON object');
  }
  const data = value as Record<string, unknown>;
  if (typeof data.call !== 'string') throw new RobotDecisionError('the model reply had no usable call');
  if (/[\r\n]/.test(data.call)) throw new RobotDecisionError('the model reply was not one short line');
  const call = data.call.trim().replace(/^['"“”]+|['"“”]+$/g, '').replace(/\s+/g, ' ');
  if (call.length === 0 || call.length > 240) {
    throw new RobotDecisionError('the model reply was not one short line');
  }
  return call;
}

/** The old title-matched call, kept only as a logged backstop when the model call fails. */
export function cannedRobotDecision(topicTitle: string): string {
  const name = topicTitle.toLowerCase();
  if (name.includes('counter staff')) return "Let's ring Auntie Mary and offer her the double pay. If she says no, I'll take the counter myself till ten.";
  if (name.includes('regulars')) return "We can't go back to a dollar thirty, we lose money on every cup. Let's keep the price and have someone at the counter explain it to the regulars this morning.";
  if (name.includes('laptop')) return "Let's put signs on the tables saying they're for breakfast from eight to ten. Staff don't ask anyone to move, they just point at the sign.";
  if (name.includes('food safety')) return "We open at eight, but nothing from that fridge goes out. I'll give the officer both logs, and someone calls the customer back this morning.";
  if (name.includes('delivery')) return "Let's push the fifty-dollar platter to the offices instead of single sets, since that one actually makes money.";
  throw new Error(`No canned call prepared for: ${topicTitle}`);
}

function failureWarning(request: RobotDecisionRequest, error: unknown): string {
  const kind = error instanceof LlmError
    ? 'model request failed'
    : error instanceof RobotDecisionError
      ? error.message
      : 'model call failed';
  return `Model guest call failed for "${request.topicTitle}" (${kind}); used the logged canned call`;
}

/** One model call for the guest's call; on failure the canned backstop stands in with a warning. */
export async function decideRobotCall(
  request: RobotDecisionRequest,
  model: RobotDecisionModel,
): Promise<RobotDecisionOutcome> {
  try {
    const raw = await model.complete(robotDecisionPrompt(request), {
      json: true, temperature: 0.6, maxTokens: 160, reasoningEffort: 'none',
    });
    return { call: parseRobotDecision(raw) };
  } catch (error) {
    return { call: cannedRobotDecision(request.topicTitle), warning: failureWarning(request, error) };
  }
}
