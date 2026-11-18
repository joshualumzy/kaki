import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../src/llm';
import { readGuestLine, type GuestReaderInput, type GuestReaderPorts } from '../../src/npc/guestReader';

const input: GuestReaderInput = {
  topic: {
    title: 'Prep',
    decision: 'how do we cover the counter?',
    canWait: false,
    deadline: 'before doors open at 8',
  },
  openQuestion: { from: 'Sam', text: 'Josh, what is your call?' },
  guestLines: ['Let us call Auntie Mary in, and Bao covers the till from eight.'],
  colleagues: [
    {
      name: 'Ada',
      facts: [{ id: '0:0', text: 'The fridge log shows a three hour gap.' }],
      catches: [{ id: '0:catch:0', text: 'Calling Ada in means double pay.' }],
    },
    {
      name: 'Bao',
      facts: [{ id: '0:1', text: 'The till needs a new login.' }],
      catches: [],
    },
    { name: 'Sam', facts: [], catches: [] },
  ],
  recentHeard: [
    { speaker: 'Sam', text: 'Josh, what is your call?' },
  ],
  line: 'Let us call Auntie Mary in, and Bao covers the till from eight.',
};

function reading(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    kind: 'idea',
    addressee: 'Ada',
    answersOpenQuestion: false,
    relevantFactIds: ['0:1'],
    relevantCatchIds: ['0:catch:0'],
    readiness: {
      action: { covered: true, evidence: 'call Auntie Mary in' },
      catchAddressed: { covered: false },
      practical: { covered: true, evidence: 'Bao covers the till from eight' },
    },
    ...overrides,
  });
}

function streamOf(...chunks: string[]): (messages: ChatMessage[], signal: AbortSignal) => AsyncIterable<string> {
  return () => (async function* () {
    for (const chunk of chunks) yield chunk;
  })();
}

function failStream(message: string): (messages: ChatMessage[], signal: AbortSignal) => AsyncIterable<string> {
  return () => (async function* () {
    throw new Error(message);
  })();
}

function ports(overrides: Partial<GuestReaderPorts> = {}): GuestReaderPorts & { logs: string[] } {
  const logs: string[] = [];
  const base: GuestReaderPorts & { logs: string[] } = {
    logs,
    stream: streamOf(reading()),
    log: (message) => logs.push(message),
    ...overrides,
  };
  return base;
}

describe('guest line reader', () => {
  it('returns the structured reading for a valid reply', async () => {
    const p = ports();
    const result = await readGuestLine(input, p);

    expect(result).toMatchObject({
      kind: 'idea',
      addressee: 'Ada',
      answersOpenQuestion: false,
      relevantFactIds: ['0:1'],
      relevantCatchIds: ['0:catch:0'],
      readiness: {
        action: { covered: true, evidence: 'call Auntie Mary in' },
        catchAddressed: { covered: false },
        practical: { covered: true, evidence: 'Bao covers the till from eight' },
      },
    });
    expect(p.logs).toContainEqual(expect.stringMatching(/^\[reader\] kind=idea addressee=Ada covered=action,practical ms=/));
  });

  it('retries on the backup model after invalid JSON', async () => {
    const calls: string[] = [];
    const p = ports({
      stream: streamOf('not json at all'),
      fallbackStream: (messages, signal) => {
        calls.push(messages[0]?.content ?? '');
        return streamOf(reading({ kind: 'answer' }))(messages, signal);
      },
    });

    const result = await readGuestLine(input, p);
    expect(result.kind).toBe('answer');
    expect(calls).toHaveLength(1);
    expect(p.logs).toContainEqual(expect.stringContaining('[reader] failed:'));
    expect(p.logs).toContainEqual(expect.stringContaining('retrying on the backup model'));
  });

  it('returns a loud unsure reading when both models fail', async () => {
    const p = ports({
      stream: streamOf('{nope'),
      fallbackStream: failStream('backup down'),
    });

    const result = await readGuestLine(input, p);
    expect(result.kind).toBe('unsure');
    expect(result.readiness).toEqual({
      action: { covered: false },
      catchAddressed: { covered: false },
      practical: { covered: false },
    });
    expect(p.logs).toContainEqual(expect.stringContaining('[reader] failed: backup down; treating the line as unsure'));
  });

  it('accepts evidence that differs only in case and whitespace', async () => {
    const p = ports({
      stream: streamOf(reading({
        readiness: {
          action: { covered: true, evidence: 'CALL   auntie mary IN' },
          catchAddressed: { covered: false },
          practical: { covered: false },
        },
      })),
    });

    const result = await readGuestLine(input, p);
    expect(result.readiness.action).toEqual({ covered: true, evidence: 'CALL   auntie mary IN' });
  });

  it('accepts evidence that differs only in punctuation and casing', async () => {
    const p = ports({
      stream: streamOf(reading({
        readiness: {
          action: { covered: true, evidence: 'CALL, auntie mary -- IN!' },
          catchAddressed: { covered: false },
          practical: { covered: false },
        },
      })),
    });

    const result = await readGuestLine(input, p);
    expect(result.readiness.action).toEqual({ covered: true, evidence: 'CALL, auntie mary -- IN!' });
  });

  it('stops a stalled read after the first-output deadline and gives up at the total budget', async () => {
    vi.useFakeTimers();
    const logs: string[] = [];
    const hang = (): AsyncIterable<string> => ({
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<string>>(() => undefined),
          return: async () => ({ done: true as const, value: undefined }),
        };
      },
    });
    const p = ports({
      stream: () => hang(),
      fallbackStream: () => hang(),
      log: (message) => logs.push(message),
      firstOutputTimeoutMs: 3_000,
      totalTimeoutMs: 6_000,
    });

    const pending = readGuestLine(input, p);
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(3_000);
    const result = await pending;

    expect(result.kind).toBe('unsure');
    expect(logs).toContainEqual(expect.stringContaining('[reader] failed:'));
    expect(logs).toContainEqual(expect.stringContaining('retrying on the backup model'));
    expect(logs).toContainEqual(expect.stringContaining('treating the line as unsure'));
    vi.useRealTimers();
  });

  it('drops evidence that is not a verbatim quote of the guest words', async () => {
    const p = ports({
      stream: streamOf(reading({
        readiness: {
          action: { covered: true, evidence: 'call the agency temp' },
          catchAddressed: { covered: false },
          practical: { covered: false },
        },
      })),
    });

    const result = await readGuestLine(input, p);
    expect(result.readiness.action).toEqual({ covered: false });
    expect(p.logs).toContainEqual(expect.stringContaining('[reader] dropped unsupported evidence "call the agency temp"'));
  });

  it('drops an unknown addressee and unknown fact or catch ids', async () => {
    const p = ports({
      stream: streamOf(reading({
        addressee: 'Nobody',
        relevantFactIds: ['9:9'],
        relevantCatchIds: ['9:catch:9'],
      })),
    });

    const result = await readGuestLine(input, p);
    expect(result.addressee).toBeUndefined();
    expect(result.relevantFactIds).toEqual([]);
    expect(result.relevantCatchIds).toEqual([]);
    expect(p.logs).toContainEqual(expect.stringContaining('[reader] dropped unknown addressee "Nobody"'));
  });
});

describe('guest line reader offer choices and deadlines', () => {
  it('accepts a chosenOption that is a valid index into the offered choices', async () => {
    const offered: GuestReaderInput = {
      ...input,
      offer: { choices: ['Ask Auntie Mary to come in', 'An agency temp needs notice'] },
    };
    const p = ports({ stream: streamOf(reading({ kind: 'agree', chosenOption: 1 })) });

    const result = await readGuestLine(offered, p);
    expect(result.kind).toBe('agree');
    expect(result.chosenOption).toBe(1);
  });

  it('drops a chosenOption that is out of range for the offered choices', async () => {
    const offered: GuestReaderInput = {
      ...input,
      offer: { choices: ['Ask Auntie Mary to come in', 'An agency temp needs notice'] },
    };
    const p = ports({ stream: streamOf(reading({ kind: 'agree', chosenOption: 5 })) });

    const result = await readGuestLine(offered, p);
    expect(result.chosenOption).toBeUndefined();
    expect(p.logs).toContainEqual(expect.stringContaining('[reader] dropped out-of-range chosenOption 5'));
  });

  it('gives up within the total budget when the stream only ends after it is aborted', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const onlyEndsOnAbort = (_messages: ChatMessage[], signal: AbortSignal): AsyncIterable<string> => {
      signals.push(signal);
      return {
        [Symbol.asyncIterator]() {
          return {
            next: () => new Promise<IteratorResult<string>>(() => undefined),
            return: () => new Promise<IteratorResult<string>>(() => undefined),
          };
        },
      };
    };
    const p = ports({
      stream: onlyEndsOnAbort,
      fallbackStream: onlyEndsOnAbort,
      firstOutputTimeoutMs: 3_000,
      totalTimeoutMs: 6_000,
    });

    const pending = readGuestLine(input, p);
    await vi.advanceTimersByTimeAsync(6_000);
    const result = await pending;

    expect(result.kind).toBe('unsure');
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    vi.useRealTimers();
  });
});
