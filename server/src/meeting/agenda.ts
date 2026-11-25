import { isObject } from '@kaki/shared';

export interface AgendaItem {
  title: string;
  minutes?: number;
  /** The workspace member who owns this item, by stable account id. */
  ownerUserId?: string;
}

export const MAX_AGENDA_ITEMS = 20;
export const MAX_AGENDA_TITLE_LENGTH = 120;
export const MIN_AGENDA_MINUTES = 1;
export const MAX_AGENDA_MINUTES = 240;

export const AGENDA_LIST_MESSAGE = 'The agenda must be a list of items.';
export const AGENDA_SHAPE_MESSAGE =
  'Each agenda item needs a title of 1-120 characters and whole minutes from 1 to 240.';

type AgendaParse = { ok: true; agenda: AgendaItem[] } | { ok: false; error: string };

interface AgendaItemOptions {
  nullMinutes?: boolean;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function agendaItemFrom(value: unknown, options: AgendaItemOptions): AgendaItem | undefined {
  if (!isObject(value) || !hasOnlyKeys(value, ['title', 'minutes', 'ownerUserId'])) return undefined;
  if (typeof value.title !== 'string') return undefined;
  const title = value.title.trim();
  if (title.length < 1 || title.length > MAX_AGENDA_TITLE_LENGTH) return undefined;
  const rawOwner = value.ownerUserId;
  if (rawOwner !== undefined && (typeof rawOwner !== 'string' || rawOwner.trim() === '')) {
    return undefined;
  }
  const ownerUserId = typeof rawOwner === 'string' ? rawOwner.trim() : undefined;
  const rawMinutes = value.minutes;
  if (rawMinutes === undefined || (rawMinutes === null && options.nullMinutes === true)) {
    return { title, ...(ownerUserId === undefined ? {} : { ownerUserId }) };
  }
  if (
    typeof rawMinutes !== 'number' ||
    !Number.isInteger(rawMinutes) ||
    rawMinutes < MIN_AGENDA_MINUTES ||
    rawMinutes > MAX_AGENDA_MINUTES
  ) {
    return undefined;
  }
  return {
    title,
    minutes: rawMinutes,
    ...(ownerUserId === undefined ? {} : { ownerUserId }),
  };
}

export function parseAgendaInput(value: unknown): AgendaParse {
  if (!Array.isArray(value)) return { ok: false, error: AGENDA_LIST_MESSAGE };
  if (value.length > MAX_AGENDA_ITEMS) {
    return { ok: false, error: `An agenda can have at most ${MAX_AGENDA_ITEMS} items.` };
  }
  const agenda: AgendaItem[] = [];
  for (const candidate of value) {
    const item = agendaItemFrom(candidate, { nullMinutes: false });
    if (item === undefined) return { ok: false, error: AGENDA_SHAPE_MESSAGE };
    agenda.push(item);
  }
  return { ok: true, agenda };
}

/** A model may draft titles and minutes only; agenda owners always come from the owner's picks. */
export function parseModelAgendaItem(value: unknown): AgendaItem | undefined {
  const item = agendaItemFrom(value, { nullMinutes: true });
  if (item === undefined) return undefined;
  return { title: item.title, ...(item.minutes === undefined ? {} : { minutes: item.minutes }) };
}

export function agendaFromStored(value: unknown): AgendaItem[] {
  if (value === null || value === undefined) return [];
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch (error) {
      throw new Error('kaki meetings: the stored agenda is not valid JSON', { cause: error });
    }
  }
  const result = parseAgendaInput(parsed);
  if (!result.ok) throw new Error(`kaki meetings: the stored agenda is malformed: ${result.error}`);
  return result.agenda;
}
