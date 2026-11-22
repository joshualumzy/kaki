import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../src/services/llm';
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
      catches: [{ id: '0:catch:0', idea: 'calling Ada in', text: 'Calling Ada in means double pay.' }],
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

  it('keeps a reading whose extra fields the model left out (seen live)', async () => {
    // The exact shape the school model returned in live runs: no answersOpenQuestion.
    const p = ports({ stream: streamOf(JSON.stringify({
      kind: 'agree', relevantFactIds: [], relevantCatchIds: [],
      readiness: { action: { covered: false }, catchAddressed: { covered: false }, practical: { covered: false } },
    })) });
    const result = await readGuestLine(input, p);
    expect(result).toMatchObject({ kind: 'agree', answersOpenQuestion: false });
    expect(p.logs).toContainEqual('[reader] defaulted missing fields: answersOpenQuestion');
    expect(p.logs).toContainEqual(expect.stringContaining('[reader] derived answersOpenQuestion=false'));
  });

  it('derives answersOpenQuestion from the kind when the guest answers the question put to them (seen live)', async () => {
    // The live line chose a call while answering Sam, but the model left the field out.
    const live: GuestReaderInput = {
      ...input,
      openQuestion: { from: 'Sam', to: 'Josh', text: 'Where is your head at on the regulars and the price?' },
      guest: 'Josh',
      guestLines: ['Uncle Lim vouches, small cup at old price, floor team knows the rest.'],
      line: 'Uncle Lim vouches, small cup at old price, floor team knows the rest.',
    };
    const p = ports({ stream: streamOf(JSON.stringify({
      kind: 'idea',
      relevantFactIds: [],
      relevantCatchIds: [],
      readiness: {
        action: { covered: true, evidence: 'small cup at old price' },
        catchAddressed: { covered: false },
        practical: { covered: false },
      },
    })) });

    const result = await readGuestLine(live, p);
    expect(result).toMatchObject({ kind: 'idea', answersOpenQuestion: true });
    expect(p.logs).toContainEqual('[reader] defaulted missing fields: answersOpenQuestion');
    expect(p.logs).toContainEqual(expect.stringContaining('[reader] derived answersOpenQuestion=true'));
  });

  it('does not derive an answer when the open question was put to a colleague', async () => {
    const toColleague: GuestReaderInput = {
      ...input,
      openQuestion: { from: 'Sam', to: 'Ada', text: 'Ada, can the counter take a new login?' },
      guest: 'Josh',
    };
    const p = ports({ stream: streamOf(JSON.stringify({
      kind: 'idea',
      relevantFactIds: [],
      relevantCatchIds: [],
      readiness: {
        action: { covered: true, evidence: 'call Auntie Mary in' },
        catchAddressed: { covered: false },
        practical: { covered: false },
      },
    })) });

    const result = await readGuestLine(toColleague, p);
    expect(result.answersOpenQuestion).toBe(false);
    expect(p.logs).toContainEqual(expect.stringContaining('[reader] derived answersOpenQuestion=false'));
  });

  it('shows every field in a filled skeleton and says when no question is open', async () => {
    let seen: ChatMessage[] = [];
    const capture = (messages: ChatMessage[]): AsyncIterable<string> => {
      seen = messages;
      return streamOf(reading())(messages, new AbortController().signal);
    };
    const p = ports({ stream: capture });

    await readGuestLine({ ...input, openQuestion: undefined }, p);
    const prompt = seen.map((message) => message.content).join('\n');
    expect(prompt).toContain('"kind":"idea"');
    expect(prompt).toContain('"answersOpenQuestion":false');
    expect(prompt).toContain('"relevantFactIds":[]');
    expect(prompt).toContain('"chosenOption":null');
    expect(prompt).toContain('0:catch:0 (reacts to: calling Ada in): "Calling Ada in means double pay."');
    expect(prompt).toContain('A catch is relevant only when the guest proposed that idea or one close to it.');
    expect(prompt).toContain('There is no open question.');
  });

  it('says a bare agreement is not a call when no concrete call was put to the guest', async () => {
    let seen: ChatMessage[] = [];
    const capture = (messages: ChatMessage[]): AsyncIterable<string> => {
      seen = messages;
      return streamOf(reading())(messages, new AbortController().signal);
    };
    const p = ports({ stream: capture });

    await readGuestLine(input, p);
    const prompt = seen.map((message) => message.content).join('\n');
    expect(prompt).toContain(
      'A bare "yes", "ok" or "let\'s go with that" agrees with what was just put to the guest, but it is not a call when no concrete call was put to them: in that case leave the action slot uncovered, and the host will offer one concrete call.',
    );
  });

  it('names who an open question is addressed to', async () => {
    let seen: ChatMessage[] = [];
    const capture = (messages: ChatMessage[]): AsyncIterable<string> => {
      seen = messages;
      return streamOf(reading())(messages, new AbortController().signal);
    };
    const p = ports({ stream: capture });

    await readGuestLine({ ...input, openQuestion: { from: 'Sam', to: 'Josh', text: 'Josh, what is your call?' } }, p);
    const prompt = seen.map((message) => message.content).join('\n');
    expect(prompt).toContain('Open question from Sam to Josh: "Josh, what is your call?"');
  });

  it('defaults every missing field but the kind, and treats a null slot as uncovered', async () => {
    const p = ports({ stream: streamOf(JSON.stringify({ kind: 'question', readiness: { action: null } })) });
    const result = await readGuestLine(input, p);
    expect(result).toMatchObject({
      kind: 'question', answersOpenQuestion: false, relevantFactIds: [], relevantCatchIds: [],
      readiness: { action: { covered: false }, catchAddressed: { covered: false }, practical: { covered: false } },
    });
    expect(p.fallbackStream).toBeUndefined();
  });

  it('logs the raw reply when the kind itself is unusable', async () => {
    const p = ports({ stream: streamOf(JSON.stringify({ kind: 'banana' })) });
    const result = await readGuestLine(input, p);
    expect(result.kind).toBe('unsure');
    expect(p.logs).toContainEqual(expect.stringContaining('not a valid reading: "{\\"kind\\":\\"banana\\"}"'));
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
    expect(p.logs).toContainEqual(expect.stringContaining('[llm-fallback] [reader] failed'));
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

  it('keeps the reader\'s mark that a line changes the earlier call', async () => {
    const p = ports({
      stream: streamOf(reading({
        readiness: {
          action: { covered: true, evidence: 'call auntie mary in', revises: true },
          catchAddressed: { covered: false, revises: true },
          practical: { covered: false },
        },
      })),
    });

    const result = await readGuestLine(input, p);
    expect(result.readiness.action).toEqual({ covered: true, evidence: 'call auntie mary in', revises: true });
    expect(result.readiness.catchAddressed).toEqual({ covered: false });
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
    expect(logs).toContainEqual(expect.stringContaining('[llm-fallback] [reader] failed'));
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

describe('guest line reader names', () => {
  const withMei: GuestReaderInput = {
    ...input,
    colleagues: [...input.colleagues, { name: 'Mei', facts: [], catches: [] }],
  };

  it('takes a name spelled by sound ("May") as the one colleague it sounds like (seen live)', async () => {
    const p = ports({ stream: streamOf(reading({ addressee: 'May' })) });
    const result = await readGuestLine(withMei, p);
    expect(result.addressee).toBe('Mei');
  });

  it('keeps the colleague a line calls on by name when both models fail (seen live)', async () => {
    const p = ports({ stream: streamOf('{nope'), fallbackStream: failStream('backup down') });
    const result = await readGuestLine({ ...withMei, line: 'Bao, what happens to our listing if we raise the price?' }, p);
    expect(result.kind).toBe('unsure');
    expect(result.addressee).toBe('Bao');
  });

  it('does not invent an addressee from a name inside the line when both models fail', async () => {
    const p = ports({ stream: streamOf('{nope'), fallbackStream: failStream('backup down') });
    const result = await readGuestLine({ ...withMei, line: 'I think Bao covers the till.' }, p);
    expect(result.addressee).toBeUndefined();
  });
});
