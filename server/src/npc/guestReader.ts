/**
 * One structured reading of a finished guest line, from the model and never from word lists.
 *
 * The reader is the only thing that decides what a guest meant: whether it was an idea, a question,
 * an answer, agreement, confusion, a request to park the topic, noise, or off topic. It also proposes
 * which decision slots the guest's own words cover, with a verbatim quote for each. The planner checks
 * those quotes against the lines the room actually heard; a quote we cannot find is dropped here.
 */

import { parseJsonReply, type ChatMessage } from '../llm';

export type GuestLineKind =
  | 'idea'
  | 'question'
  | 'answer'
  | 'agree'
  | 'backchannel'
  | 'unsure'
  | 'park'
  | 'off_topic'
  | 'noise';

export type DecisionSlotName = 'action' | 'catchAddressed' | 'practical';

/** One decision slot the guest may have covered, with the guest's own words as evidence. */
export interface DecisionSlot {
  covered: boolean;
  evidence?: string;
}

export interface GuestReadiness {
  action: DecisionSlot;
  catchAddressed: DecisionSlot;
  practical: DecisionSlot;
}

/** What one guest line meant and which decision slots it covered. */
export interface GuestReading {
  kind: GuestLineKind;
  addressee?: string;
  answersOpenQuestion: boolean;
  relevantFactIds: string[];
  relevantCatchIds: string[];
  readiness: GuestReadiness;
  /** The zero-based index of the offered choice the guest picked, after validation. */
  chosenOption?: number;
}

/** The exact call or choice Sam put to the guest in an open offer. */
export interface GuestReaderOffer {
  proposal?: string;
  choices?: readonly string[];
}

export interface GuestReaderTopic {
  title: string;
  decision?: string;
  canWait: boolean;
  deadline: string;
}

export interface GuestReaderColleague {
  name: string;
  facts: readonly { id: string; text: string }[];
  catches: readonly { id: string; text: string }[];
}

export interface GuestReaderInput {
  topic: GuestReaderTopic;
  openQuestion?: { from: string; text: string };
  /** The guest's own heard lines on this topic, oldest first, including the new line. */
  guestLines: readonly string[];
  /** Everyone present except the guest, with the fact and catch ids they can speak to. */
  colleagues: readonly GuestReaderColleague[];
  /** The last few heard lines on the topic, oldest first. */
  recentHeard: readonly { speaker: string; text: string }[];
  /** The call or choices Sam has put to the guest and is waiting on. */
  offer?: GuestReaderOffer;
  /** The AI colleague whose line was playing when the guest said this, if any. */
  saidWhileSpeaking?: string;
  /** The finished guest line to read. */
  line: string;
}

export interface GuestReaderPorts {
  stream(messages: ChatMessage[], signal: AbortSignal): AsyncIterable<string>;
  fallbackStream?(messages: ChatMessage[], signal: AbortSignal): AsyncIterable<string>;
  log?(message: string): void;
  /** How long one attempt may take to produce its first output before it is abandoned. */
  firstOutputTimeoutMs?: number;
  /** The whole read's budget across both attempts. */
  totalTimeoutMs?: number;
  /** Older name for the first-output deadline, kept for callers that still pass it. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_FIRST_OUTPUT_TIMEOUT_MS = 3_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 6_000;

const KINDS: readonly GuestLineKind[] = [
  'idea', 'question', 'answer', 'agree', 'backchannel', 'unsure', 'park', 'off_topic', 'noise',
];

const SLOTS: readonly DecisionSlotName[] = ['action', 'catchAddressed', 'practical'];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when `quote` really appears in the guest's heard words; the check we control, not a guess. */
export function evidenceIsSupported(quote: string, guestLines: readonly string[]): boolean {
  const wanted = normalise(quote);
  if (wanted.length === 0) return false;
  return normalise(guestLines.join(' ')).includes(wanted);
}

function readSlot(value: unknown, guestLines: readonly string[], log: (message: string) => void): DecisionSlot {
  // A missing or malformed slot means "not covered": only the kind is essential to a reading.
  if (!isObject(value) || value.covered !== true) return { covered: false };
  const evidence = typeof value.evidence === 'string' ? value.evidence.trim() : '';
  if (evidence.length === 0) {
    log('[reader] dropped unsupported evidence: a covered slot had no verbatim quote');
    return { covered: false };
  }
  if (!evidenceIsSupported(evidence, guestLines)) {
    log(`[reader] dropped unsupported evidence "${evidence.slice(0, 120)}"`);
    return { covered: false };
  }
  return { covered: true, evidence };
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) return undefined;
  return value.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

function validateReading(
  value: unknown,
  input: GuestReaderInput,
  log: (message: string) => void,
): GuestReading | undefined {
  if (!isObject(value)) return undefined;
  if (typeof value.kind !== 'string' || !KINDS.includes(value.kind as GuestLineKind)) return undefined;
  // Only the kind is essential. Models often omit the other fields; each falls back to its safe default
  // (not answering, no ids, nothing covered), so a usable reading is never thrown away for a missing extra.
  const missing: string[] = [];
  if (typeof value.answersOpenQuestion !== 'boolean') missing.push('answersOpenQuestion');
  const factIds = stringArray(value.relevantFactIds) ?? (missing.push('relevantFactIds'), []);
  const catchIds = stringArray(value.relevantCatchIds) ?? (missing.push('relevantCatchIds'), []);
  const readiness = isObject(value.readiness) ? value.readiness : (missing.push('readiness'), {});
  if (missing.length > 0) log(`[reader] defaulted missing fields: ${missing.join(', ')}`);

  const present = new Set(input.colleagues.map((colleague) => colleague.name));
  const knownFactIds = new Set(input.colleagues.flatMap((colleague) => colleague.facts.map((fact) => fact.id)));
  const knownCatchIds = new Set(input.colleagues.flatMap((colleague) => colleague.catches.map((entry) => entry.id)));

  const addressee = typeof value.addressee === 'string' && present.has(value.addressee.trim())
    ? value.addressee.trim()
    : undefined;
  if (typeof value.addressee === 'string' && value.addressee.trim().length > 0 && addressee === undefined) {
    log(`[reader] dropped unknown addressee "${value.addressee.slice(0, 80)}"`);
  }

  const keptFactIds = factIds.filter((id) => knownFactIds.has(id));
  const keptCatchIds = catchIds.filter((id) => knownCatchIds.has(id));
  if (keptFactIds.length !== factIds.length) log('[reader] dropped unknown fact ids');
  if (keptCatchIds.length !== catchIds.length) log('[reader] dropped unknown catch ids');

  const slots: Partial<GuestReadiness> = {};
  for (const name of SLOTS) {
    slots[name] = readSlot(readiness[name], input.guestLines, log);
  }

  let chosenOption: number | undefined;
  if (value.chosenOption !== undefined) {
    const choices = input.offer?.choices ?? [];
    const index = typeof value.chosenOption === 'number' ? value.chosenOption : Number.NaN;
    if (Number.isInteger(index) && index >= 0 && index < choices.length) {
      chosenOption = index;
    } else {
      log(`[reader] dropped out-of-range chosenOption ${String(value.chosenOption)}`);
    }
  }

  return {
    kind: value.kind as GuestLineKind,
    ...(addressee === undefined ? {} : { addressee }),
    answersOpenQuestion: value.answersOpenQuestion === true,
    relevantFactIds: keptFactIds,
    relevantCatchIds: keptCatchIds,
    readiness: {
      action: slots.action!,
      catchAddressed: slots.catchAddressed!,
      practical: slots.practical!,
    },
    ...(chosenOption === undefined ? {} : { chosenOption }),
  };
}

function unsureReading(): GuestReading {
  return {
    kind: 'unsure',
    answersOpenQuestion: false,
    relevantFactIds: [],
    relevantCatchIds: [],
    readiness: {
      action: { covered: false },
      catchAddressed: { covered: false },
      practical: { covered: false },
    },
  };
}

function describeInput(input: GuestReaderInput): string {
  const lines: string[] = [];
  lines.push(`Topic: "${input.topic.title}"`);
  lines.push(`The decision the room needs: "${input.topic.decision ?? 'what do we do about this?'}"`);
  lines.push(input.topic.canWait
    ? `This topic can wait; its later slot is "${input.topic.deadline}".`
    : `This topic is urgent; it must be decided "${input.topic.deadline}".`);
  lines.push(input.openQuestion === undefined
    ? 'No question is open right now.'
    : `Open question from ${input.openQuestion.from}: "${input.openQuestion.text}"`);
  const heard = input.recentHeard.length === 0
    ? 'Nothing has been heard on this topic yet.'
    : input.recentHeard.map((line) => `${line.speaker}: ${line.text}`).join('\n');
  lines.push(`The last lines heard on this topic, oldest first:\n${heard}`);
  if (input.offer !== undefined) {
    const put = input.offer.proposal !== undefined
      ? `"${input.offer.proposal}"`
      : (input.offer.choices ?? []).map((choice, index) => `${index}: "${choice}"`).join(', ');
    lines.push(`Sam has just put this to the guest and is waiting for an answer:\n${put}`);
  }
  const guestLines = input.guestLines.length === 0
    ? 'The guest has not spoken on this topic before.'
    : input.guestLines.map((line) => `- ${line}`).join('\n');
  lines.push(`The guest's own heard lines on this topic:\n${guestLines}`);
  const colleagues = input.colleagues.map((colleague) => {
    const facts = colleague.facts.length === 0
      ? 'no facts'
      : colleague.facts.map((fact) => `${fact.id}: "${fact.text}"`).join('; ');
    const catches = colleague.catches.length === 0
      ? 'no catches'
      : colleague.catches.map((entry) => `${entry.id}: "${entry.text}"`).join('; ');
    return `- ${colleague.name}: ${facts}; ${catches}`;
  });
  lines.push(`Present colleagues and what they know:\n${colleagues.join('\n')}`);
  lines.push(input.saidWhileSpeaking === undefined
    ? `The guest's new line: "${input.line}"`
    : `The guest's new line, said while ${input.saidWhileSpeaking} was talking: "${input.line}"`);
  return lines.join('\n\n');
}

function readerMessages(input: GuestReaderInput): ChatMessage[] {
  const system = [
    'You read one line from a live meeting guest and return only a JSON object.',
    'Do not answer the guest, do not write for the meeting, and do not add commentary. Return strict JSON only.',
    '',
    'Fields:',
    '"kind": one of "idea", "question", "answer", "agree", "backchannel", "unsure", "park", "off_topic", "noise".',
    '"addressee": a present colleague\'s exact name when the guest is clearly speaking to them, otherwise omit it.',
    '"answersOpenQuestion": true only when the guest is answering the open question shown.',
    '"relevantFactIds": fact ids from the list that the guest\'s point touches, or [].',
    '"relevantCatchIds": catch ids from the list that the guest\'s point touches, or [].',
    '"chosenOption": when Sam has put a list of numbered choices to the guest and the guest clearly picked one, the zero-based index of that choice. Otherwise omit it. Never guess an option the guest did not pick.',
    '"readiness": {"action": slot, "catchAddressed": slot, "practical": slot}.',
    'A slot is {"covered": true, "evidence": "<the guest\'s exact words, copied verbatim>"} or {"covered": false}.',
    'The evidence must be a word-for-word substring of one of the guest\'s own lines. Never paraphrase it.',
    '"action" means the guest has actually chosen what to do about this topic.',
    '"catchAddressed" means the guest has answered the real catch or cost that was raised against their idea.',
    '"practical" means the immediate who/what/when is clear, or the guest has named a safe interim step.',
    'When the guest has not said it, the slot is not covered. Never fill a slot from what the meeting suggested.',
    '',
    'What each kind means:',
    '- "idea": the guest proposes or chooses something for the topic, including one phrased as a question: "what if we open the window bar?", "shall we cut the menu?".',
    '- "question": the guest asks the room something, even when speech-to-text left out the question mark: "can the till take a new login".',
    '- "answer": the guest answers the open question without proposing a new idea.',
    '- "agree": a bare "yes", "ok", "sure", "sounds good", "do it" that accepts what was just put to them. This is never filler and never noise. When a list of offers was put, "agree" alone does not pick one; use "chosenOption" only when the guest clearly names one.',
    '- "backchannel": a short listener sound said while someone else is talking, meaning "go on": "mm", "mm-hmm", "oh", "ah", "I see", "gotcha", "right". It is not agreement and not an answer, even when it follows a question. It only occurs while another person is speaking.',
    '- "unsure": "not sure", "I don\'t know", "idk", "what do you mean?", "I don\'t understand". This is a request for help.',
    '- "park": the guest wants to leave this topic for later: "let\'s leave it for later", "can we come back to this?".',
    '- "noise": a microphone test, a cough, silence, or garbled text with no meaning: "can you hear me?", "testing".',
    '- "off_topic": the guest is talking about something that is not this topic or this meeting.',
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: describeInput(input) },
  ];
}

async function collect(
  stream: AsyncIterable<string>,
  firstOutputMs: number,
  budgetMs: number,
  onTimeoutAbort?: () => void,
): Promise<string> {
  const iterator = stream[Symbol.asyncIterator]();
  const FIRST = Symbol('first');
  const BUDGET = Symbol('budget');
  let firstTimer: ReturnType<typeof setTimeout> | undefined;
  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const firstOutput = new Promise<typeof FIRST>((resolve) => {
    firstTimer = setTimeout(() => {
      stopped = true;
      resolve(FIRST);
    }, firstOutputMs);
    firstTimer.unref?.();
  });
  const budget = new Promise<typeof BUDGET>((resolve) => {
    budgetTimer = setTimeout(() => {
      stopped = true;
      resolve(BUDGET);
    }, budgetMs);
    budgetTimer.unref?.();
  });
  let text = '';
  let sawFirst = false;
  try {
    for (;;) {
      const raced = await Promise.race([iterator.next(), firstOutput, budget]);
      if (raced === FIRST) throw new Error(`the read produced no output within ${firstOutputMs} ms`);
      if (raced === BUDGET) throw new Error(`the read timed out after ${budgetMs} ms`);
      if (raced.done === true) return text;
      if (!sawFirst) {
        sawFirst = true;
        if (firstTimer !== undefined) clearTimeout(firstTimer);
        firstTimer = undefined;
      }
      text += raced.value;
    }
  } finally {
    if (firstTimer !== undefined) clearTimeout(firstTimer);
    if (budgetTimer !== undefined) clearTimeout(budgetTimer);
    if (stopped) {
      // Abort the request first, then let the stream's own cleanup settle in the background. Awaiting it
      // would hang the read when the stream only ends once its signal aborts.
      onTimeoutAbort?.();
      void Promise.resolve(iterator.return?.()).catch(() => undefined);
    }
  }
}

async function attempt(
  input: GuestReaderInput,
  ports: GuestReaderPorts,
  stream: (messages: ChatMessage[], signal: AbortSignal) => AsyncIterable<string>,
  log: (message: string) => void,
  firstOutputMs: number,
  budgetMs: number,
): Promise<GuestReading> {
  const abort = new AbortController();
  const signal = ports.signal === undefined ? abort.signal : AbortSignal.any([ports.signal, abort.signal]);
  try {
    const content = await collect(
      stream(readerMessages(input), signal), firstOutputMs, budgetMs, () => abort.abort());
    let parsed: unknown;
    try {
      parsed = parseJsonReply(content);
    } catch {
      throw new Error(`the reply was not JSON: ${JSON.stringify(content.slice(0, 200))}`);
    }
    const reading = validateReading(parsed, input, log);
    if (reading === undefined) throw new Error(`the reply was not a valid reading: ${JSON.stringify(content.slice(0, 200))}`);
    return reading;
  } finally {
    if (!signal.aborted) abort.abort();
  }
}

function coveredNames(reading: GuestReading): string {
  const covered = SLOTS.filter((slot) => reading.readiness[slot].covered);
  return covered.length === 0 ? 'none' : covered.join(',');
}

/**
 * Read one finished guest line. One model call, then one retry on the backup model; on both failing
 * this returns a loud `unsure` reading and never throws into the meeting.
 */
export async function readGuestLine(input: GuestReaderInput, ports: GuestReaderPorts): Promise<GuestReading> {
  const log = ports.log ?? (() => undefined);
  const startedAt = Date.now();
  const firstOutputMs = ports.firstOutputTimeoutMs ?? ports.timeoutMs ?? DEFAULT_FIRST_OUTPUT_TIMEOUT_MS;
  const totalMs = ports.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  const deadline = startedAt + totalMs;
  const remainingMs = (): number => Math.max(1, deadline - Date.now());
  let failure: string;
  try {
    const reading = await attempt(input, ports, ports.stream, log, firstOutputMs, remainingMs());
    logReader(log, reading, Date.now() - startedAt);
    return reading;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }

  if (ports.fallbackStream !== undefined && remainingMs() > 50) {
    log(`[reader] failed: ${failure}; retrying on the backup model`);
    try {
      const reading = await attempt(
        input, ports, ports.fallbackStream, log, Math.min(firstOutputMs, remainingMs()), remainingMs());
      logReader(log, reading, Date.now() - startedAt);
      return reading;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
  }

  log(`[reader] failed: ${failure}; treating the line as unsure`);
  const reading = unsureReading();
  logReader(log, reading, Date.now() - startedAt);
  return reading;
}

function logReader(log: (message: string) => void, reading: GuestReading, ms: number): void {
  log(
    `[reader] kind=${reading.kind} addressee=${reading.addressee ?? 'none'} ` +
    `covered=${coveredNames(reading)} ms=${ms}`,
  );
}
