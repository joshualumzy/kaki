import { isObject } from '@kaki/shared';
import { parseJsonReply } from '../services/llm';

/** Parse the one JSON object an LLM draft reply should hold, or undefined when it is unusable. */
export function parseDraftObject(reply: string): Record<string, unknown> | undefined {
  let value: unknown;
  try {
    value = parseJsonReply(reply);
  } catch {
    return undefined;
  }
  return isObject(value) ? value : undefined;
}

/** One string field from a draft, or '' when it is absent or not a string. */
export function draftString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  return typeof field === 'string' ? field : '';
}
