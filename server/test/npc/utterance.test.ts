import { describe, expect, it, vi } from 'vitest';
import { SttError, UtteranceRecorder, type Recognizer, type SpeechStart, type SpeechTiming, type SttSession } from '../../src/npc/utterance';

const RATE = 1000; // 1 sample = 1 ms, to keep the arithmetic readable
const block = (ms: number, value = 1): Int16Array => new Int16Array(ms).fill(value);

function fake() {
  const sessions: Array<{ pushed: number[]; finished: boolean; cancelled: boolean; resolve(text: string): void }> = [];
  const recognizer: Recognizer = {
    start(): SttSession {
      let resolve: (text: string) => void = () => undefined;
      const result = new Promise<string>((done) => (resolve = done));
      const entry = { pushed: [] as number[], finished: false, cancelled: false, resolve };
      sessions.push(entry);
      return {
        push: (samples) => void entry.pushed.push(samples.length),
        finish: () => ((entry.finished = true), result),
        cancel: () => void (entry.cancelled = true),
      };
    },
  };
  const texts: string[] = [];
  const recorder = new UtteranceRecorder(recognizer, { sampleRate: RATE, prerollMs: 300, minMs: 200, maxMs: 5000, onText: (t) => texts.push(t) });
  return { sessions, recorder, texts };
}

const total = (pushed: number[]): number => pushed.reduce((sum, n) => sum + n, 0);

describe('UtteranceRecorder', () => {
  it('sends nothing while nobody is talking', () => {
    const { sessions, recorder } = fake();
    for (let i = 0; i < 50; i++) recorder.push(block(100));
    expect(sessions).toHaveLength(0);
  });

  it('opens a session with a little audio from just before the detector fired, then everything until it stops', async () => {
    const { sessions, recorder, texts } = fake();
    for (let i = 0; i < 20; i++) recorder.push(block(100)); // 2 s of silence: only the last ~300 ms is kept
    recorder.speaking(true);
    expect(total(sessions[0]!.pushed)).toBe(300);
    recorder.push(block(100));
    recorder.push(block(100));
    recorder.speaking(false);
    expect(total(sessions[0]!.pushed)).toBe(500);
    await vi.waitFor(() => expect(sessions[0]!.finished).toBe(true));
    sessions[0]!.resolve('  hello there ');
    await vi.waitFor(() => expect(texts).toEqual(['hello there']));
  });

  it('does not send audio after the speech ended, and does not reuse the pre-roll', () => {
    const { sessions, recorder } = fake();
    recorder.push(block(300));
    recorder.speaking(true);
    recorder.speaking(false);
    recorder.push(block(100));
    expect(total(sessions[0]!.pushed)).toBe(300);
    recorder.speaking(true);
    expect(total(sessions[1]!.pushed)).toBe(100);
  });

  it('sends no audio at all while suspended, and starts a fresh stretch after resume', () => {
    const { sessions, recorder } = fake();
    recorder.push(block(300));
    recorder.speaking(true);
    expect(sessions).toHaveLength(1);
    // Off the record: the stretch in progress is cancelled and every frame is dropped.
    recorder.suspend();
    expect(sessions[0]!.cancelled).toBe(true);
    recorder.push(block(300));
    recorder.speaking(false);
    recorder.push(block(300));
    expect(sessions).toHaveLength(1);

    // Back on the record: a new stretch sends only the audio that arrives after the resume.
    recorder.resume();
    recorder.speaking(true);
    expect(sessions).toHaveLength(2);
    expect(total(sessions[1]!.pushed)).toBe(0);
    recorder.push(block(200));
    expect(total(sessions[1]!.pushed)).toBe(200);
    recorder.speaking(false);
  });

  it('throws away a stretch too short to be speech', () => {
    const { sessions, recorder, texts } = fake();
    recorder.push(block(100));
    recorder.speaking(true);
    recorder.speaking(false);
    expect(sessions[0]!.cancelled).toBe(true);
    expect(sessions[0]!.finished).toBe(false);
    expect(texts).toEqual([]);
  });

  it('hands results over in the order the speech happened, even if the first is slow', async () => {
    const { sessions, recorder, texts } = fake();
    recorder.push(block(300));
    recorder.speaking(true);
    recorder.speaking(false);
    recorder.push(block(300));
    recorder.speaking(true);
    recorder.speaking(false);
    sessions[1]!.resolve('second');
    await Promise.resolve();
    expect(texts).toEqual([]);
    sessions[0]!.resolve('first');
    await vi.waitFor(() => expect(texts).toEqual(['first', 'second']));
  });

  it('cuts a stretch that never ends, and ignores empty results', async () => {
    const { sessions, recorder, texts } = fake();
    recorder.push(block(300));
    recorder.speaking(true);
    for (let i = 0; i < 60; i++) recorder.push(block(100));
    await vi.waitFor(() => expect(sessions[0]!.finished).toBe(true));
    sessions[0]!.resolve('   ');
    await Promise.resolve();
    expect(texts).toEqual([]);
  });

  it('cancels the open session when the track goes away', () => {
    const { sessions, recorder } = fake();
    recorder.push(block(300));
    recorder.speaking(true);
    recorder.close();
    expect(sessions[0]!.cancelled).toBe(true);
  });
});

describe('UtteranceRecorder debug audio', () => {
  it('hands over everything it sent, pre-roll included, in order', () => {
    const heard: Int16Array[] = [];
    const recorder = new UtteranceRecorder({ start: () => ({ push: () => undefined, finish: async () => '', cancel: () => undefined }) }, {
      sampleRate: RATE, prerollMs: 300, minMs: 200, onText: () => undefined, onAudio: (samples) => heard.push(samples),
    });
    recorder.push(block(300, 1));
    recorder.speaking(true);
    recorder.push(block(100, 2));
    recorder.speaking(false);
    expect(heard).toHaveLength(1);
    expect(heard[0]?.length).toBe(400);
    expect([heard[0]?.[0], heard[0]?.[399]]).toEqual([1, 2]);
  });
});

describe('UtteranceRecorder nothing heard', () => {
  it('says so when recognition returns no words', async () => {
    let nothing = 0;
    const texts: string[] = [];
    const recorder = new UtteranceRecorder(
      { start: () => ({ push: () => undefined, finish: async () => '  ', cancel: () => undefined }) },
      { sampleRate: RATE, prerollMs: 300, minMs: 200, onText: (t) => texts.push(t), onNothing: () => void (nothing += 1) },
    );
    recorder.push(block(300));
    recorder.speaking(true);
    recorder.speaking(false);
    await vi.waitFor(() => expect(nothing).toBe(1));
    expect(texts).toEqual([]);
  });
});

describe('UtteranceRecorder speech timing', () => {
  it('reports when the speech began and ended, pre-roll included', async () => {
    const starts: SpeechStart[] = [];
    const results: Array<{ text: string; timing: SpeechTiming }> = [];
    let finishCalled = false;
    let resolve: (text: string) => void = () => undefined;
    const recorder = new UtteranceRecorder(
      {
        start: () => ({
          push: () => undefined,
          finish: () => {
            finishCalled = true;
            return new Promise<string>((done) => (resolve = done));
          },
          cancel: () => undefined,
        }),
      },
      {
        sampleRate: RATE,
        prerollMs: 300,
        minMs: 200,
        onSpeechStart: (start) => starts.push(start),
        onText: (text, timing) => results.push({ text, timing }),
      },
    );
    recorder.push(block(300));
    recorder.speaking(true);
    recorder.push(block(700));
    const beforeEnd = Date.now();
    recorder.speaking(false);
    const afterEnd = Date.now();
    await vi.waitFor(() => expect(finishCalled).toBe(true));
    resolve('hello');
    await vi.waitFor(() => expect(results).toHaveLength(1));

    expect(starts).toHaveLength(1);
    expect(results[0]?.text).toBe('hello');
    expect(results[0]?.timing.id).toBe(starts[0]?.id);
    // The start reaches back over the audio kept before the detector fired; the end is when speech stopped.
    expect(results[0]!.timing.startedAt).toBeLessThanOrEqual(starts[0]!.startedAt);
    expect(results[0]!.timing.endedAt).toBeGreaterThanOrEqual(beforeEnd);
    expect(results[0]!.timing.endedAt).toBeLessThanOrEqual(afterEnd + 1000);
  });

  it('reports a recognition failure with its timing instead of only logging it', async () => {
    const failures: Array<{ error: unknown; timing: SpeechTiming }> = [];
    const recorder = new UtteranceRecorder(
      { start: () => ({ push: () => undefined, finish: async () => { throw new Error('quota exceeded'); }, cancel: () => undefined }) },
      {
        sampleRate: RATE,
        prerollMs: 300,
        minMs: 200,
        onText: () => undefined,
        onFailure: (error, timing) => failures.push({ error, timing }),
      },
    );
    recorder.push(block(300));
    recorder.speaking(true);
    recorder.push(block(700));
    recorder.speaking(false);
    await vi.waitFor(() => expect(failures).toHaveLength(1));
    expect(String(failures[0]!.error)).toMatch(/quota exceeded/);
    expect(failures[0]!.timing.endedAt).toBeGreaterThanOrEqual(failures[0]!.timing.startedAt);
  });

  it('settles a stretch that is too short to recognise', () => {
    const discarded: SpeechTiming[] = [];
    const recorder = new UtteranceRecorder(
      { start: () => ({ push: () => undefined, finish: async () => '', cancel: () => undefined }) },
      { sampleRate: RATE, prerollMs: 300, minMs: 200, onText: () => undefined, onSpeechDiscarded: (timing) => discarded.push(timing) },
    );
    recorder.push(block(100));
    recorder.speaking(true);
    recorder.speaking(false);
    expect(discarded).toHaveLength(1);
  });
});

describe('UtteranceRecorder retries', () => {
  function flaky(finishes: Array<() => Promise<string>>) {
    const sessions: Array<{ pushed: number[]; finished: boolean; cancelled: boolean }> = [];
    let index = 0;
    const recognizer: Recognizer = {
      start(): SttSession {
        const outcome = finishes[Math.min(index, finishes.length - 1)]!;
        index += 1;
        const entry = { pushed: [] as number[], finished: false, cancelled: false };
        sessions.push(entry);
        return {
          push: (samples) => void entry.pushed.push(samples.length),
          finish: () => ((entry.finished = true), outcome()),
          cancel: () => void (entry.cancelled = true),
        };
      },
    };
    const texts: string[] = [];
    const failures: unknown[] = [];
    const logs: string[] = [];
    const recorder = new UtteranceRecorder(recognizer, {
      sampleRate: RATE,
      prerollMs: 300,
      minMs: 200,
      maxMs: 5000,
      retryBackoffMs: 1,
      onText: (text) => texts.push(text),
      onFailure: (error) => failures.push(error),
      log: (message) => logs.push(message),
    });
    return { sessions, recorder, texts, failures, logs };
  }

  function speak(recorder: UtteranceRecorder): void {
    recorder.push(block(300));
    recorder.speaking(true);
    recorder.push(block(200));
    recorder.speaking(false);
  }

  it('retries a throttled stretch from the same audio and keeps the line once', async () => {
    const { sessions, recorder, texts, failures, logs } = flaky([
      () => Promise.reject(new SttError('429 Too Many Requests', true)),
      () => Promise.resolve('hello there'),
    ]);

    speak(recorder);

    await vi.waitFor(() => expect(texts).toEqual(['hello there']));
    expect(failures).toEqual([]);
    expect(sessions).toHaveLength(2);
    expect(total(sessions[0]!.pushed)).toBe(500);
    // The retry sends exactly the same stretch again, pre-roll included.
    expect(total(sessions[1]!.pushed)).toBe(500);
    expect(logs.some((message) => message.includes('[stt] retry'))).toBe(true);
  });

  it('tries a bounded number of times, then tells the person it failed', async () => {
    const { sessions, recorder, texts, failures, logs } = flaky([
      () => Promise.reject(new SttError('503 Service Unavailable', true)),
    ]);

    speak(recorder);

    await vi.waitFor(() => expect(failures).toHaveLength(1));
    expect(texts).toEqual([]);
    expect(sessions).toHaveLength(3);
    expect(logs.filter((message) => message.includes('[stt] retry'))).toHaveLength(2);
    expect(logs.some((message) => message.includes('[stt] speech recognition failed'))).toBe(true);
  });

  it('does not retry a bad key and reports it plainly', async () => {
    const { sessions, recorder, texts, failures, logs } = flaky([
      () => Promise.reject(new SttError('Authentication failed: bad subscription key', false)),
    ]);

    speak(recorder);

    await vi.waitFor(() => expect(failures).toHaveLength(1));
    expect(texts).toEqual([]);
    expect(sessions).toHaveLength(1);
    expect(logs.some((message) => message.includes('Authentication failed'))).toBe(true);
    expect(logs.some((message) => message.includes('[stt] retry'))).toBe(false);
  });
});
