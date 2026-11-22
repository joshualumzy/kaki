import { describe, expect, it, vi } from 'vitest';
import {
  BEHAVIOURS,
  behaviourForPersona,
  cardFollowPrompt,
  duplicatedAiLines,
  isVisitorAddress,
  judgeCardFollowsFinalCall,
  parseCardFollowVerdict,
  rejoinResumes,
  rejoinWelcome,
  reversalLine,
  silencePromptWithin,
  type TranscriptLine,
} from './playtest-behaviours';

const at = (seconds: number): string => new Date(Date.UTC(2026, 0, 1, 9, 0, seconds)).toISOString();
const line = (seconds: number, speaker: string, text: string, agendaIndex = 0): TranscriptLine => ({
  at: at(seconds), agendaIndex, speaker, text,
});

describe('behaviour selection', () => {
  it('keeps the four behaviour personas separate from the wording-only personas', () => {
    expect(BEHAVIOURS).toEqual(['silent', 'interrupter', 'flip-flop', 'rejoin']);
    for (const behaviour of BEHAVIOURS) expect(behaviourForPersona(behaviour)).toBe(behaviour);
    for (const persona of ['hesitant', 'terse', 'off-topic', 'inventive', 'delegator', 'unknown']) {
      expect(behaviourForPersona(persona)).toBeUndefined();
    }
  });
});

describe('silent', () => {
  it('recognises the visitor by full name or a distinctive name word', () => {
    expect(isVisitorAddress('Robot Visitor, what is your call?', 'Robot Visitor')).toBe(true);
    expect(isVisitorAddress('Robot, are you still there?', 'Robot Visitor')).toBe(true);
    expect(isVisitorAddress('Sam, what is your call?', 'Robot Visitor')).toBe(false);
    expect(isVisitorAddress('anything', '')).toBe(false);
  });

  it('passes when the host names the visitor within the window, and fails otherwise', () => {
    const quietAt = Date.parse(at(0));
    const within = [line(5, 'Mei', 'We need a call.'), line(20, 'Sam', 'Robot Visitor, what do you think?')];
    expect(silencePromptWithin(within, 0, 'Robot Visitor', quietAt, 60_000, 'Sam')).toMatchObject({
      prompted: true, waitedMs: 20_000, text: 'Robot Visitor, what do you think?',
    });

    const late = [line(61, 'Sam', 'Robot Visitor?')];
    expect(silencePromptWithin(late, 0, 'Robot Visitor', quietAt, 60_000, 'Sam').prompted).toBe(false);

    const colleague = [line(5, 'Mei', 'Robot Visitor, any view?')];
    expect(silencePromptWithin(colleague, 0, 'Robot Visitor', quietAt, 60_000, 'Sam').prompted).toBe(false);

    const robot = [line(5, 'Robot Visitor', 'Robot Visitor is here')];
    expect(silencePromptWithin(robot, 0, 'Robot Visitor', quietAt, 60_000, 'Sam').prompted).toBe(false);

    expect(silencePromptWithin(within, 2, 'Robot Visitor', quietAt, 60_000, 'Sam').prompted).toBe(false);
  });
});

describe('interrupter', () => {
  it('finds AI lines repeated word for word and ignores the robot', () => {
    const lines = [
      line(1, 'Sam', 'Let us begin.'),
      line(2, 'Robot Visitor', 'A line.'),
      line(3, 'Mei', 'Let us begin.'),
      line(4, 'Mei', 'A different line.'),
    ];
    expect(duplicatedAiLines(lines)).toEqual(['Let us begin.']);
    expect(duplicatedAiLines(lines, 2)).toEqual([]);
    expect(duplicatedAiLines(lines, 3)).toEqual([]);
  });
});

describe('flip-flop', () => {
  const first = 'Ask Auntie Mary to come in on double pay.';
  const final = 'Actually, scrap that — use an agency temp for the rush.';

  it('asks the model to judge the whole card against both calls', () => {
    const prompt = cardFollowPrompt({ decisionSource: `${first} ${final}` }, first, final)
      .map((message) => message.content).join('\n');
    expect(prompt).toContain(`First (superseded) call: ${first}`);
    expect(prompt).toContain(`Final call: ${final}`);
    expect(prompt).toContain('must not contain the superseded call');
    expect(prompt).toContain('Card decision source:');
  });

  it('accepts only a clear verdict with a one-line reason', () => {
    expect(parseCardFollowVerdict('{"follows":false,"reason":"It keeps both calls."}'))
      .toEqual({ follows: false, reason: 'It keeps both calls.' });
    expect(() => parseCardFollowVerdict('{oops')).toThrow(/not valid JSON/);
    expect(() => parseCardFollowVerdict('{"follows":"yes","reason":"ok"}')).toThrow(/no usable verdict/);
    expect(() => parseCardFollowVerdict('{"follows":true,"reason":""}')).toThrow(/no usable reason/);
  });

  it('uses the model verdict for a combined old-and-new card', async () => {
    const model = { complete: vi.fn(async (_messages: unknown, _options?: unknown) => '{"follows":false,"reason":"It still contains the old double-pay call."}') };
    await expect(judgeCardFollowsFinalCall({ decisionSource: `${first} ${final}` }, first, final, model))
      .resolves.toEqual({ follows: false, reason: 'It still contains the old double-pay call.' });
    expect(model.complete).toHaveBeenCalledTimes(1);
    expect(model.complete.mock.calls[0]![1]).toMatchObject({ json: true, temperature: 0 });
  });

  it('fails loudly when there is no final call to judge', async () => {
    const model = { complete: vi.fn(async () => '{"follows":true,"reason":"ok"}') };
    await expect(judgeCardFollowsFinalCall({ decisionSource: '' }, first, '', model))
      .rejects.toThrow(/final call is empty/);
    expect(model.complete).not.toHaveBeenCalled();
  });

  it('adds the reversal phrase only once', () => {
    expect(reversalLine('use an agency temp')).toBe('Actually, scrap that — use an agency temp');
    expect(reversalLine('Actually, scrap that — use an agency temp')).toBe('Actually, scrap that — use an agency temp');
  });
});

describe('rejoin', () => {
  it('passes when the agenda stays on the same or next topic with its cards', () => {
    expect(rejoinResumes({
      agendaBefore: 0, agendaAfter: 1, closingAfter: false, hostWelcomeAfter: false,
      earlierTaskIds: ['t1'], currentTaskIds: ['t1', 't2'], secondsToRejoin: 12,
    })).toEqual({ ok: true, reasons: [] });
  });

  it('fails a restart, a second welcome, missing cards, or a slow rejoin', () => {
    const verdict = rejoinResumes({
      agendaBefore: 1, agendaAfter: 0, closingAfter: true, hostWelcomeAfter: true,
      earlierTaskIds: ['t1', 't2'], currentTaskIds: ['t3'], secondsToRejoin: 25,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(' | ')).toMatch(/restarted or jumped/);
    expect(verdict.reasons.join(' | ')).toMatch(/wrap-up/);
    expect(verdict.reasons.join(' | ')).toMatch(/opening\/welcome/);
    expect(verdict.reasons.join(' | ')).toMatch(/t1, t2/);
    expect(verdict.reasons.join(' | ')).toMatch(/25\.0 s/);
  });

  it('detects a repeated opening line from the host', () => {
    const lines = [
      line(0, 'Sam', 'Welcome everyone, let us begin.'),
      line(10, 'Mei', 'A topic line.'),
      line(20, 'Sam', 'Welcome everyone, let us begin.'),
    ];
    expect(rejoinWelcome(lines, 2, 'Sam', 'Welcome everyone, let us begin.')).toMatchObject({ speaker: 'Sam' });
    expect(rejoinWelcome(lines, 2, 'Sam')).toMatchObject({ speaker: 'Sam' });
    expect(rejoinWelcome(lines, 3, 'Sam')).toBeUndefined();
    expect(rejoinWelcome([line(2, 'Mei', 'Welcome back.')], 0, 'Sam')).toBeUndefined();
    // The one welcome-back line on return is expected, not a second opening.
    expect(rejoinWelcome([line(2, 'Sam', 'Welcome back — we were on the delivery app commission.')], 0, 'Sam')).toBeUndefined();
  });
});
