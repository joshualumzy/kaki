import type { ChatMessage } from '../llm';
import type { Utterance } from './director';

/** A fault the live demo can be told to show on purpose; see KAKI_FAULT. */
export const FAULTS = ['control-garbled', 'slow-first', 'stall-mid', 'tts-fail'] as const;
export type Fault = (typeof FAULTS)[number];

/** Read KAKI_FAULT: unset (or empty) is off, a known value is on, anything else is a startup error. */
export function faultFromEnv(raw: string | undefined): Fault | undefined {
  const value = raw?.trim();
  if (value === undefined || value.length === 0) return undefined;
  if (!(FAULTS as readonly string[]).includes(value)) {
    throw new Error(`KAKI_FAULT must be one of ${FAULTS.join(', ')}; got "${raw}"`);
  }
  return value as Fault;
}

export type StreamFn = (messages: ChatMessage[], signal: AbortSignal) => AsyncIterable<string>;
export type SynthesizeFn<Clip> = (utterance: Utterance, signal: AbortSignal) => Promise<Clip>;

const SLOW_FIRST_MS = 15_000;
const DEFAULT_IDLE_MS = 10_000;

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

async function* corruptControl(stream: StreamFn, messages: ChatMessage[], signal: AbortSignal): AsyncGenerator<string> {
  let buffer = '';
  let done = false;
  for await (const chunk of stream(messages, signal)) {
    if (done) {
      yield chunk;
      continue;
    }
    buffer += chunk;
    for (let newline = buffer.indexOf('\n'); !done && newline >= 0; newline = buffer.indexOf('\n')) {
      const line = buffer.slice(0, newline);
      const rest = buffer.slice(newline + 1);
      if (line.trim().length === 0) {
        yield `${line}\n`;
        buffer = rest;
        continue;
      }
      const corrupted = line.startsWith('KAKI_CONTROL') ? line.replace('{', '{oops ') : line;
      yield `${corrupted}\n${rest}`;
      buffer = '';
      done = true;
    }
  }
  if (!done && buffer.length > 0) {
    yield buffer.startsWith('KAKI_CONTROL') ? buffer.replace('{', '{oops ') : buffer;
  }
}

async function* slowFirst(stream: StreamFn, messages: ChatMessage[], signal: AbortSignal): AsyncGenerator<string> {
  let first = true;
  for await (const chunk of stream(messages, signal)) {
    if (first) {
      first = false;
      await wait(SLOW_FIRST_MS, signal);
    }
    if (signal.aborted) return;
    yield chunk;
  }
}

async function* stallMid(
  stream: StreamFn,
  messages: ChatMessage[],
  signal: AbortSignal,
  idleMs: number,
): AsyncGenerator<string> {
  let buffer = '';
  for await (const chunk of stream(messages, signal)) {
    buffer += chunk;
    // The control line and the first spoken line: enough for the room to hear one sentence.
    if (buffer.split('\n').length < 3) continue;
    yield buffer;
    await wait(idleMs, signal);
    if (signal.aborted) return;
    // No more chunks arrive, which is what the stream's idle deadline would cut.
    throw new Error(`LLM stream failed: the reply stalled for ${idleMs} ms between chunks`);
  }
  if (buffer.length > 0) yield buffer;
}

/** Wrap the stream port for the selected fault; every other value passes it straight through. */
export function faultyStream(stream: StreamFn, fault: Fault | undefined, idleMs = DEFAULT_IDLE_MS): StreamFn {
  switch (fault) {
    case 'control-garbled':
      return (messages, signal) => corruptControl(stream, messages, signal);
    case 'slow-first':
      return (messages, signal) => slowFirst(stream, messages, signal);
    case 'stall-mid':
      return (messages, signal) => stallMid(stream, messages, signal, idleMs);
    default:
      return stream;
  }
}

/** Wrap the speech port for the selected fault; every other value passes it straight through. */
export function faultySynthesize<Clip>(
  synthesize: SynthesizeFn<Clip>,
  fault: Fault | undefined,
): SynthesizeFn<Clip> {
  if (fault !== 'tts-fail') return synthesize;
  return async () => {
    throw new Error('KAKI_FAULT=tts-fail: speech synthesis is off');
  };
}
