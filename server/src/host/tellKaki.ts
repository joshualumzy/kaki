import { isObject } from '@kaki/shared';
import { parseJsonReply, type ChatMessage, type LlmClient } from '../services/llm';
import {
  MAX_AGENDA_ITEMS,
  MAX_AGENDA_TITLE_LENGTH,
  parseModelAgendaItem,
  type AgendaItem,
} from '../meeting/agenda';

export interface TellKakiReply {
  title: string | null;
  agenda: AgendaItem[];
}

export const TELL_KAKI_REPLY_MESSAGE = "Couldn't read that; fill it in yourself.";
export const TELL_KAKI_UNAVAILABLE_MESSAGE = "Kaki isn't available right now; fill it in yourself.";

export class TellKakiReplyError extends Error {
  constructor() {
    super(TELL_KAKI_REPLY_MESSAGE);
  }
}

const SYSTEM_PROMPT = [
  'Fill a meeting title and agenda from what the person wrote, and from nothing else.',
  "Keep the person's own words wherever possible.",
  'Never add an agenda item, time, duration, owner, role, or fact they did not write.',
  'Use null for the title when their text does not name or describe a meeting.',
  'Each agenda item must be something they wrote. Put minutes only when their text states a duration for that item; otherwise use null.',
  'Keep their order, and return no more than 20 agenda items.',
].join('\n');

export const TELL_KAKI_SCHEMA: { name: string; schema: Record<string, unknown> } = {
  name: 'tell_kaki',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'agenda'],
    properties: {
      title: {
        anyOf: [{ type: 'string' }, { type: 'null' }],
      },
      agenda: {
        type: 'array',
        maxItems: MAX_AGENDA_ITEMS,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'minutes'],
          properties: {
            title: { type: 'string' },
            minutes: {
              anyOf: [
                { type: 'integer', minimum: 1, maximum: 240 },
                { type: 'null' },
              ],
            },
          },
        },
      },
    },
  },
};

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export function parseTellKakiReply(content: string): TellKakiReply {
  let value: unknown;
  try {
    value = parseJsonReply(content);
  } catch {
    throw new TellKakiReplyError();
  }
  if (!isObject(value) || !hasOnlyKeys(value, ['title', 'agenda'])) {
    throw new TellKakiReplyError();
  }

  const rawTitle = value.title;
  let title: string | null;
  if (rawTitle === null) {
    title = null;
  } else if (typeof rawTitle === 'string') {
    title = rawTitle.trim();
    if (title.length < 1 || title.length > MAX_AGENDA_TITLE_LENGTH) throw new TellKakiReplyError();
  } else {
    throw new TellKakiReplyError();
  }

  if (!Array.isArray(value.agenda) || value.agenda.length > MAX_AGENDA_ITEMS) {
    throw new TellKakiReplyError();
  }
  const agenda: AgendaItem[] = [];
  for (const rawItem of value.agenda) {
    const item = parseModelAgendaItem(rawItem);
    if (item === undefined) throw new TellKakiReplyError();
    agenda.push(item);
  }
  return { title, agenda };
}

export function tellKakiMessages(text: string): ChatMessage[] {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: text },
  ];
}

export async function askTellKaki(llm: LlmClient, text: string): Promise<TellKakiReply> {
  const content = await llm.complete(tellKakiMessages(text), {
    json: true,
    schema: TELL_KAKI_SCHEMA,
  });
  return parseTellKakiReply(content);
}
