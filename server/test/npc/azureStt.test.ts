import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => {
  type Behavior = 'ok' | 'hang' | 'fail';

  class FakeRecognizer {
    static instances: FakeRecognizer[] = [];
    static startBehavior: Behavior = 'ok';
    static stopBehavior: Behavior = 'ok';
    static stops = 0;

    recognized: ((sender: unknown, event: unknown) => void) | undefined;
    sessionStopped: (() => void) | undefined;
    canceled: ((sender: unknown, event: unknown) => void) | undefined;
    closed = false;

    constructor() {
      FakeRecognizer.instances.push(this);
    }

    startContinuousRecognitionAsync(ok: () => void, fail: (error: unknown) => void): void {
      if (FakeRecognizer.startBehavior === 'hang') return;
      if (FakeRecognizer.startBehavior === 'fail') {
        fail(new Error('start failed'));
        return;
      }
      ok();
    }

    stopContinuousRecognitionAsync(ok: () => void, fail: () => void): void {
      FakeRecognizer.stops += 1;
      if (FakeRecognizer.stopBehavior === 'hang') return;
      if (FakeRecognizer.stopBehavior === 'fail') {
        fail();
        return;
      }
      ok();
    }

    close(): void {
      this.closed = true;
    }
  }

  class FakeSpeechConfig {
    speechRecognitionLanguage = '';
    outputFormat = 0;

    static fromSubscription(): FakeSpeechConfig {
      return new FakeSpeechConfig();
    }
  }

  const addedPhrases: string[][] = [];

  return {
    FakeRecognizer,
    SpeechRecognizer: FakeRecognizer,
    SpeechConfig: FakeSpeechConfig,
    OutputFormat: { Detailed: 1 },
    ResultReason: { RecognizedSpeech: 1 },
    PropertyId: { SpeechServiceResponse_JsonResult: 'json' },
    CancellationReason: { Error: 1 },
    CancellationErrorCode: {
      NoError: 0,
      AuthenticationFailure: 1,
      BadRequestParameters: 2,
      TooManyRequests: 3,
      ConnectionFailure: 4,
      ServiceTimeout: 5,
      ServiceError: 6,
      RuntimeError: 7,
      Forbidden: 8,
    },
    AudioInputStream: {
      createPushStream: () => ({
        write: () => undefined,
        close: () => undefined,
      }),
    },
    AudioStreamFormat: { getWaveFormatPCM: () => ({}) },
    AudioConfig: { fromStreamInput: () => ({}) },
    addedPhrases,
    PhraseListGrammar: {
      fromRecognizer: () => ({
        addPhrases: (phrases: string[]) => {
          addedPhrases.push([...phrases]);
        },
      }),
    },
  };
});

vi.mock('microsoft-cognitiveservices-speech-sdk', () => sdk);

import { createAzureStt } from '../../src/npc/azureStt';
import { isRetryableSttError } from '../../src/npc/utterance';
import { MAX_STT_PHRASES } from '../../src/npc/sttPhrases';

const TIMEOUT_MS = 1_000;

function createSession(finishTimeoutMs = TIMEOUT_MS) {
  const stt = createAzureStt('key', 'region', { locale: 'en-SG', phrases: () => [], finishTimeoutMs });
  const session = stt.start();
  const recognizer = sdk.FakeRecognizer.instances.at(-1)!;
  return { session, recognizer };
}

function heard(recognizer: InstanceType<typeof sdk.FakeRecognizer>, text: string): void {
  recognizer.recognized?.(undefined, {
    result: {
      reason: sdk.ResultReason.RecognizedSpeech,
      text,
      properties: { getProperty: () => '' },
    },
  });
}

describe('createAzureStt', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sdk.FakeRecognizer.instances = [];
    sdk.FakeRecognizer.startBehavior = 'ok';
    sdk.FakeRecognizer.stopBehavior = 'ok';
    sdk.FakeRecognizer.stops = 0;
    sdk.addedPhrases.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads the phrase list again for every stretch of speech', () => {
    const phrases = vi.fn().mockReturnValueOnce(['Ana', 'Ana', '  ']).mockReturnValueOnce(['Ben']);
    const stt = createAzureStt('key', 'region', { locale: 'en-SG', phrases, finishTimeoutMs: TIMEOUT_MS });

    stt.start();
    stt.start();

    expect(phrases).toHaveBeenCalledTimes(2);
    expect(sdk.addedPhrases).toEqual([['Ana'], ['Ben']]);
  });

  it('caps a huge phrase list and says so once', () => {
    const log = vi.fn();
    const many = Array.from({ length: MAX_STT_PHRASES + 1 }, (_, index) => `phrase ${index}`);
    const stt = createAzureStt('key', 'region', {
      locale: 'en-SG',
      phrases: () => many,
      finishTimeoutMs: TIMEOUT_MS,
      log,
    });

    stt.start();
    stt.start();

    expect(sdk.addedPhrases.map((phrases) => phrases.length)).toEqual([MAX_STT_PHRASES, MAX_STT_PHRASES]);
    expect(log.mock.calls.filter(([message]) => message.includes('capped'))).toHaveLength(1);
  });

  it('fails loudly and closes the recognizer when starting never answers', async () => {
    sdk.FakeRecognizer.startBehavior = 'hang';
    const { session, recognizer } = createSession();

    const result = session.finish();
    const assertion = expect(result).rejects.toThrow('did not start in time');
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);

    await assertion;
    expect(recognizer.closed).toBe(true);
    expect(sdk.FakeRecognizer.stops).toBe(1);
  });

  it('fails loudly instead of returning partial speech when stopping never answers', async () => {
    sdk.FakeRecognizer.stopBehavior = 'hang';
    const { session, recognizer } = createSession();
    heard(recognizer, 'half a sentence');

    const result = session.finish();
    const assertion = expect(result).rejects.toThrow('did not finish in time');
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);

    await assertion;
    expect(recognizer.closed).toBe(true);
    expect(sdk.FakeRecognizer.stops).toBe(1);
  });

  it('returns the recognised words once the session ends in time', async () => {
    const { session, recognizer } = createSession();
    heard(recognizer, 'hello there');
    recognizer.sessionStopped?.();

    await expect(session.finish()).resolves.toBe('hello there');
    expect(recognizer.closed).toBe(true);
  });

  it('reports a recognition error as a failure', async () => {
    const { session } = createSession();
    sdk.FakeRecognizer.instances.at(-1)!.canceled?.(undefined, {
      reason: sdk.CancellationReason.Error,
      errorDetails: 'network down',
    });

    await expect(session.finish()).rejects.toThrow('network down');
  });

  it('marks a throttle as worth retrying and a bad key as final', async () => {
    const throttle = createSession();
    throttle.recognizer.canceled?.(undefined, {
      reason: sdk.CancellationReason.Error,
      errorCode: sdk.CancellationErrorCode.TooManyRequests,
      errorDetails: '429 too many requests',
    });
    const throttled = await throttle.session.finish().then(() => undefined, (error: unknown) => error);
    expect(isRetryableSttError(throttled)).toBe(true);

    const badKey = createSession();
    badKey.recognizer.canceled?.(undefined, {
      reason: sdk.CancellationReason.Error,
      errorCode: sdk.CancellationErrorCode.AuthenticationFailure,
      errorDetails: 'authentication failed',
    });
    const unauthorised = await badKey.session.finish().then(() => undefined, (error: unknown) => error);
    expect(isRetryableSttError(unauthorised)).toBe(false);
  });
});
