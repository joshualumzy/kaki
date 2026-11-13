import type { MeetingMemoryEntry } from '@kaki/shared';

/** A clock time that carries an explicit AM/PM in the text. */
export interface ClockTime {
  hour: number;
  minute: number;
  meridiem: 'am' | 'pm';
}

const CLOCK = /\b(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/gi;

// A range like "8 to 10:30 AM" qualifies both ends with the same AM/PM in ordinary speech. Without this, a draft
// that writes "8 AM to 10:30 AM" would be rejected even though the context supports it.
const RANGE =
  /\b(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\s*(?:to|until|through|[-–—])\s*(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/gi;

const COMPLETED_ACTION = new RegExp(
  [
    '\\b(?:has|have|had)\\s+been\\s+(posted|announced|sent|shared|published|implemented|completed|done)\\b',
    '\\b(?:we|i)\\s+(?:have\\s+)?(?:already\\s+)?(posted|announced|sent|shared|published|implemented|completed|done)\\b',
    '\\b(?:is|are)\\s+now\\s+(done)\\b',
  ].join('|'),
  'gi',
);

const IMMEDIATE_START = /\beffective\s+immediately\b/i;

function meridiemOf(value: string | undefined): 'am' | 'pm' | undefined {
  if (value === undefined) return undefined;
  return value[0]!.toLowerCase() === 'a' ? 'am' : 'pm';
}

function minuteOf(value: string | undefined): number {
  return value === undefined ? 0 : Number(value);
}

function keyOf(hour: number, minute: number, meridiem: 'am' | 'pm'): string {
  return `${hour}:${String(minute).padStart(2, '0')} ${meridiem}`;
}

function addTime(
  into: Map<string, ClockTime>,
  hourText: string | undefined,
  minuteText: string | undefined,
  meridiemText: string | undefined,
): void {
  const meridiem = meridiemOf(meridiemText);
  if (meridiem === undefined || hourText === undefined) return;
  const hour = Number(hourText);
  const minute = minuteOf(minuteText);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute > 59) return;
  into.set(keyOf(hour, minute, meridiem), { hour, minute, meridiem });
}

/** Every clock time in the text that states AM or PM, including an unqualified end of a qualified range. */
export function clockTimes(text: string): ClockTime[] {
  const found = new Map<string, ClockTime>();
  for (const match of text.matchAll(CLOCK)) {
    addTime(found, match[1], match[2], match[3]);
  }
  for (const match of text.matchAll(RANGE)) {
    const [, startHour, startMinute, startMeridiem, endHour, endMinute, endMeridiem] = match;
    const shared = startMeridiem ?? endMeridiem;
    if (startMeridiem === undefined && endMeridiem !== undefined) {
      addTime(found, startHour, startMinute, shared);
    }
    if (endMeridiem === undefined && startMeridiem !== undefined) {
      addTime(found, endHour, endMinute, shared);
    }
  }
  return [...found.values()];
}

function labelOf(time: ClockTime): string {
  const minute = time.minute === 0 ? '' : `:${String(time.minute).padStart(2, '0')}`;
  return `${time.hour}${minute} ${time.meridiem.toUpperCase()}`;
}

/**
 * The verbatim accepted decision a task carries, as a block for a draft prompt. Empty when the notetaker could not
 * establish one, so the draft prompt never invents a source.
 */
export function acceptedDecisionBlock(decisionSource: string | undefined): string {
  if (decisionSource === undefined) return '';
  return (
    '\n\nAccepted decision (verbatim from the meeting transcript; keep its time, owner and measurement):\n' +
    decisionSource
  );
}

/** Everything a draft may legitimately draw on: the task, its accepted decision and any selected facts. */
export function draftSourceText(
  task: { title: string; context: string; decisionSource?: string },
  facts: readonly string[] = [],
  memory: readonly MeetingMemoryEntry[] = [],
): string {
  return [task.title, task.context, task.decisionSource, ...facts, ...memory.map((entry) => entry.text)]
    .filter((part): part is string => part !== undefined && part.trim() !== '')
    .join('\n');
}

export function memorySourceBlock(memory: readonly MeetingMemoryEntry[] = []): string {
  return memory.length === 0 ? '' : `\n\nAlready true in this meeting:\n${memory.map((entry) =>
    `${entry.kind === 'decision' ? `Decision on ${entry.item}` : entry.item}: ${entry.text}`).join('\n')}`;
}

/**
 * Details a draft asserts that the task does not support. This is a conservative gate, not a proof of correctness:
 * it can only see explicit clock times, claims that the work is already done, and an invented immediate start. It
 * cannot judge invented nouns such as places or equipment, so the draft prompt still has to do that work.
 */
export function unsupportedDraftDetails(draft: string, source: string): string[] {
  const problems: string[] = [];

  const supportedTimes = new Set(clockTimes(source).map((time) => keyOf(time.hour, time.minute, time.meridiem)));
  for (const time of clockTimes(draft)) {
    if (!supportedTimes.has(keyOf(time.hour, time.minute, time.meridiem))) {
      problems.push(`"${labelOf(time)}" is not in the task context`);
    }
  }

  for (const match of draft.matchAll(COMPLETED_ACTION)) {
    const claim = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (claim === '' || new RegExp(`\\b${claim.replace(/\s+/g, '\\s+')}\\b`, 'i').test(source)) continue;
    const before = draft.slice(Math.max(0, (match.index ?? 0) - 45), match.index ?? 0);
    if (/\b(?:once|after|when|until|whether|if)\b[^.!?]*$/i.test(before)) continue;
    if (
      claim.toLowerCase() === 'confirmed' &&
      /\b(?:journalists?|press|reporters?|inspectors?|sfa|hospital|arrival|appointment|visit)\b[^.!?]*$/i.test(before)
    ) {
      continue;
    }
    problems.push(`"${match[0]}" says the work is already done, but the task does not`);
  }

  if (IMMEDIATE_START.test(draft) && !IMMEDIATE_START.test(source)) {
    problems.push('"effective immediately" adds a start date the task does not give');
  }

  return [...new Set(problems)];
}
