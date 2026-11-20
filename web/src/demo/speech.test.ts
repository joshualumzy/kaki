import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  browserRecognitionWanted,
  RECOGNITION_EXHAUSTED_MESSAGE,
  speechRecognitionCtor,
  startRecognizer,
  type SpeechEventLike,
  type SpeechRecognitionLike,
} from './speech';

class FakeRecognition implements SpeechRecognitionLike {
  static instances: FakeRecognition[] = [];
  continuous = false;
  interimResults = false;
  lang = '';
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onresult: ((event: SpeechEventLike) => void) | null = null;
  started = 0;
  aborted = false;
  constructor() {
    FakeRecognition.instances.push(this);
  }
  start(): void {
    this.started += 1;
    this.onstart?.();
  }
  stop(): void {}
  abort(): void {
    this.aborted = true;
  }
  /** Deliver results as the browser does: the whole list so far, and the index of the first changed one. */
  hear(resultIndex: number, ...results: Array<[string, boolean]>): void {
    const list = results.map(([transcript, isFinal]) => ({ isFinal, 0: { transcript } }));
    this.onresult?.({ resultIndex, results: Object.assign(list, { length: list.length }) });
  }
}

describe('startRecognizer', () => {
  let finals: string[];
  let interims: string[];
  let listening: boolean[];
  let fatal: string[];
  let exhausted: string[];

  const handlers = () => ({
    onFinal: (text: string) => finals.push(text),
    onInterim: (text: string) => interims.push(text),
    onListening: (on: boolean) => listening.push(on),
    onFatal: (message: string) => fatal.push(message),
    onExhausted: (message: string) => exhausted.push(message),
  });

  beforeEach(() => {
    vi.useFakeTimers();
    FakeRecognition.instances = [];
    finals = [];
    interims = [];
    listening = [];
    fatal = [];
    exhausted = [];
  });
  afterEach(() => vi.useRealTimers());

  const latest = (): FakeRecognition => FakeRecognition.instances.at(-1)!;

  it('starts a continuous session with interim results in the requested language', () => {
    startRecognizer(FakeRecognition, handlers(), { lang: 'en-SG' });
    expect(latest()).toMatchObject({ continuous: true, interimResults: true, lang: 'en-SG', started: 1 });
    expect(listening).toEqual([true]);
  });

  it('delivers each finished piece of speech exactly once, and interim words as they change', () => {
    startRecognizer(FakeRecognition, handlers());
    latest().hear(0, ['hello th', false]);
    latest().hear(0, ['hello there', true]);
    latest().hear(1, ['hello there', true], ['how are', false]);
    latest().hear(0, ['hello there', true], ['how are you', true]); // a browser re-sending the first one
    expect(finals).toEqual(['hello there', 'how are you']);
    expect(interims).toEqual(['hello th', '', 'how are', '']);
  });

  it('restarts a session the browser ended, and starts delivering from a clean slate', () => {
    startRecognizer(FakeRecognition, handlers());
    vi.advanceTimersByTime(5000);
    latest().hear(0, ['first session', true]);
    latest().onend?.();
    expect(FakeRecognition.instances).toHaveLength(1);
    vi.advanceTimersByTime(250);
    expect(FakeRecognition.instances).toHaveLength(2);
    latest().hear(0, ['second session', true]);
    expect(finals).toEqual(['first session', 'second session']);
  });

  it('backs off when sessions keep ending at once', () => {
    startRecognizer(FakeRecognition, handlers(), { restartDelayMs: 100, maxRestartDelayMs: 800 });
    const delays: number[] = [];
    for (let round = 0; round < 5; round += 1) {
      const before = FakeRecognition.instances.length;
      latest().onend?.();
      let waited = 0;
      while (FakeRecognition.instances.length === before) {
        vi.advanceTimersByTime(50);
        waited += 50;
      }
      delays.push(waited);
    }
    expect(delays).toEqual([200, 400, 800, 800, 800]);
  });

  it('stops after a bounded run of failed sessions and offers a manual retry', () => {
    startRecognizer(FakeRecognition, handlers(), {
      restartDelayMs: 50,
      maxRestartDelayMs: 100,
      maxFailures: 3,
    });

    for (let round = 0; round < 3; round += 1) {
      latest().onend?.();
      vi.advanceTimersByTime(100);
    }

    expect(FakeRecognition.instances).toHaveLength(3);
    expect(exhausted).toEqual([RECOGNITION_EXHAUSTED_MESSAGE]);
    expect(listening.at(-1)).toBe(false);

    vi.advanceTimersByTime(60_000);
    expect(FakeRecognition.instances).toHaveLength(3);
  });

  it('stops retrying a start that keeps throwing', () => {
    let attempts = 0;
    class Broken extends FakeRecognition {
      override start(): void {
        attempts += 1;
        throw new Error('already started');
      }
    }

    startRecognizer(Broken, handlers(), {
      restartDelayMs: 10,
      maxRestartDelayMs: 10,
      maxFailures: 2,
    });

    vi.advanceTimersByTime(10);
    expect(attempts).toBe(2);
    expect(exhausted).toEqual([RECOGNITION_EXHAUSTED_MESSAGE]);

    vi.advanceTimersByTime(60_000);
    expect(attempts).toBe(2);
  });

  it('treats silence as normal and does not back off for it', () => {
    startRecognizer(FakeRecognition, handlers());
    vi.advanceTimersByTime(5000);
    latest().onerror?.({ error: 'no-speech' });
    latest().onend?.();
    vi.advanceTimersByTime(250);
    expect(FakeRecognition.instances).toHaveLength(2);
  });

  it('gives up and says why when the microphone is blocked', () => {
    startRecognizer(FakeRecognition, handlers());
    latest().onerror?.({ error: 'not-allowed' });
    latest().onend?.();
    vi.advanceTimersByTime(60_000);
    expect(FakeRecognition.instances).toHaveLength(1);
    expect(fatal).toEqual(['Microphone access was blocked for speech recognition.']);
  });

  it('stop() ends the session for good, with no restart afterwards', () => {
    const stop = startRecognizer(FakeRecognition, handlers());
    const session = latest();
    stop();
    expect(session.aborted).toBe(true);
    expect(session.onend).toBeNull();
    vi.advanceTimersByTime(60_000);
    expect(FakeRecognition.instances).toHaveLength(1);
    expect(listening.at(-1)).toBe(false);
  });

  it('stop() also cancels a restart that was already waiting', () => {
    const stop = startRecognizer(FakeRecognition, handlers());
    vi.advanceTimersByTime(5000);
    latest().onend?.();
    stop();
    vi.advanceTimersByTime(60_000);
    expect(FakeRecognition.instances).toHaveLength(1);
  });

  it('keeps going if a session refuses to start', () => {
    let attempts = 0;
    class Flaky extends FakeRecognition {
      override start(): void {
        attempts += 1;
        if (attempts === 1) throw new Error('already started');
        super.start();
      }
    }
    startRecognizer(Flaky, handlers());
    vi.advanceTimersByTime(1000);
    expect(attempts).toBe(2);
    expect(listening).toEqual([true]);
  });
});

describe('speechRecognitionCtor', () => {
  it('finds the standard or the prefixed constructor, or nothing', () => {
    expect(speechRecognitionCtor({ SpeechRecognition: FakeRecognition })).toBe(FakeRecognition);
    expect(speechRecognitionCtor({ webkitSpeechRecognition: FakeRecognition })).toBe(FakeRecognition);
    expect(speechRecognitionCtor({})).toBeUndefined();
  });
});

describe('browserRecognitionWanted', () => {
  it('is off unless the page asks for the browser\'s recognition', () => {
    expect(browserRecognitionWanted('')).toBe(false);
    expect(browserRecognitionWanted('?lang=en-US')).toBe(false);
    expect(browserRecognitionWanted('?stt=server')).toBe(false);
    expect(browserRecognitionWanted('?stt=browser')).toBe(true);
    expect(browserRecognitionWanted('?lang=en-SG&stt=browser')).toBe(true);
  });
});
