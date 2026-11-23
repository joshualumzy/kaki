/** One stretch of the person's speech being recognised. */
export interface SttSession {
  /** More audio of the stretch: 16-bit mono samples. */
  push(samples: Int16Array): void;
  /** No more audio: resolves with everything recognised, or an empty string. */
  finish(): Promise<string>;
  /** Throw the stretch away. */
  cancel(): void;
}

/** Starts recognising one stretch of speech. */
export interface Recognizer {
  start(): SttSession;
}

/**
 * A speech-recognition failure. It says whether trying the same audio again could help: a throttle
 * or a dropped connection is worth retrying, a bad key or a used-up quota is not.
 */
export class SttError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = 'SttError';
  }
}

/** True only for failures the recorder should send the same stretch for again. */
export function isRetryableSttError(error: unknown): boolean {
  return error instanceof SttError && error.retryable;
}

/** One stretch of speech, identified so its result can be matched to its start. */
export interface SpeechStart {
  id: string;
  /** Wall-clock milliseconds when the speech began, including the audio kept from just before the detector fired. */
  startedAt: number;
}

/** A stretch of speech with the moment it ended and how loud the microphone was throughout it. */
export interface SpeechTiming extends SpeechStart {
  endedAt: number;
  /**
   * RMS microphone level, 0..1, over exactly the audio sent to recognition for this stretch. It is
   * the same scale the voice detector uses, so two seats hearing the same voice can be compared.
   */
  micLevel?: number;
}

interface UtteranceRecorderOptions {
  sampleRate: number;
  /** Audio kept from just before the voice detector fired, so the first syllable is not lost. */
  prerollMs?: number;
  /** A stretch longer than this is cut off: it is more likely a stuck detector than a speech. */
  maxMs?: number;
  /** Shorter than this (in audio sent) is not worth recognising. */
  minMs?: number;
  /** A stretch of speech began; every start ends with `onText`, `onNothing`, `onFailure` or `onSpeechDiscarded`. */
  onSpeechStart?(start: SpeechStart): void;
  /** Recognised text, in the order the speech happened, with the time it was actually said. */
  onText(text: string, timing: SpeechTiming): void;
  log?(message: string): void;
  /** Every stretch of audio sent for recognition, for diagnosing what the server heard. */
  onAudio?(samples: Int16Array): void;
  /** A stretch of speech was recognised as containing nothing. */
  onNothing?(timing: SpeechTiming): void;
  /** Recognition failed for a stretch; the service's reason must reach the person who spoke. */
  onFailure?(error: unknown, timing: SpeechTiming): void;
  /** A stretch was discarded without recognition (too short, or the track went away). */
  onSpeechDiscarded?(timing: SpeechTiming): void;
  /** True while finished speech audio is waiting on the speech-to-text service to return words. */
  onRecognizing?(active: boolean): void;
  /** How many times one stretch is sent for recognition before the person is told it failed (default 3). */
  recogniseTries?: number;
  /** The first wait before retrying a throttled stretch, in milliseconds; it doubles each retry (default 250). */
  retryBackoffMs?: number;
}

let nextSpeechId = 0;

const DEFAULT_RECOGNISE_TRIES = 3;
const DEFAULT_RETRY_BACKOFF_MS = 250;

function newSpeechStart(startedAt: number): SpeechStart {
  nextSpeechId += 1;
  return { id: `speech-${nextSpeechId}`, startedAt };
}

/**
 * Feeds speech recognition only the audio in which the person is talking. It listens to the same
 * microphone as the voice detector; when the detector says the person started, it opens a session
 * with a little audio from just before, passes everything until the detector says they stopped,
 * and then asks for the text. Silence, and the time the AI is talking alone, never reach the
 * recogniser, which keeps within a free allowance of audio hours.
 */
export class UtteranceRecorder {
  private readonly prerollMs: number;
  private readonly maxMs: number;
  private readonly minMs: number;
  private preroll: Int16Array[] = [];
  private prerollSamples = 0;
  private session: SttSession | undefined;
  private sentSamples = 0;
  /** Summed squares of every sample sent for this stretch, in the same 0..1 scale as the voice detector. */
  private sentSquareSum = 0;
  private sent: Int16Array[] = [];
  private chain: Promise<void> = Promise.resolve();
  private pendingRecognitions = 0;
  private speech: SpeechStart | undefined;
  private suspended = false;
  /** Bumped when listening stops; a retry must not start a fresh session after that. */
  private listeningEpoch = 0;

  constructor(
    private readonly recognizer: Recognizer,
    private readonly options: UtteranceRecorderOptions,
  ) {
    this.prerollMs = options.prerollMs ?? 400;
    this.maxMs = options.maxMs ?? 25_000;
    this.minMs = options.minMs ?? 250;
  }

  /**
   * Stop sending audio to speech recognition: any stretch in progress is thrown away and every
   * frame that arrives while suspended is dropped. Off the record, nothing the room says is sent.
   */
  suspend(): void {
    this.suspended = true;
    this.listeningEpoch += 1;
    const session = this.session;
    this.session = undefined;
    this.speech = undefined;
    session?.cancel();
    this.preroll = [];
    this.prerollSamples = 0;
    this.sent = [];
    this.sentSamples = 0;
    this.sentSquareSum = 0;
  }

  /** Start listening again; new speech opens a fresh recognition session. */
  resume(): void {
    this.suspended = false;
  }

  /** Audio from the microphone, all of it, as it arrives. */
  push(samples: Int16Array): void {
    if (this.suspended || samples.length === 0) return;
    if (this.session === undefined) {
      this.preroll.push(samples);
      this.prerollSamples += samples.length;
      const keep = (this.prerollMs / 1000) * this.options.sampleRate;
      while (this.preroll.length > 1 && this.prerollSamples - (this.preroll[0]?.length ?? 0) >= keep) {
        this.prerollSamples -= this.preroll.shift()?.length ?? 0;
      }
      return;
    }
    this.send(samples);
    if ((this.sentSamples / this.options.sampleRate) * 1000 > this.maxMs) {
      this.options.log?.(`speech recognition: cut a stretch of speech after ${this.maxMs / 1000} s`);
      this.end();
    }
  }

  /** The voice detector's verdict changed. */
  speaking(on: boolean): void {
    if (this.suspended) return;
    if (on) {
      if (this.session !== undefined) return;
      this.session = this.recognizer.start();
      this.sentSamples = 0;
      this.sentSquareSum = 0;
      this.sent = [];
      const keptMs = (this.prerollSamples / this.options.sampleRate) * 1000;
      this.speech = newSpeechStart(Date.now() - Math.round(keptMs));
      this.options.onSpeechStart?.(this.speech);
      for (const block of this.preroll) this.send(block);
      this.preroll = [];
      this.prerollSamples = 0;
    } else {
      this.end();
    }
  }

  /** The person's track went away. */
  close(): void {
    const session = this.session;
    this.session = undefined;
    if (session === undefined) return;
    session.cancel();
    const speech = this.speech;
    this.speech = undefined;
    if (speech !== undefined) this.options.onSpeechDiscarded?.({ ...speech, endedAt: Date.now(), micLevel: this.micLevel() });
  }

  private send(samples: Int16Array): void {
    this.sentSamples += samples.length;
    for (const sample of samples) this.sentSquareSum += (sample / 32768) ** 2;
    // Keep the stretch's audio until it is recognised, so a throttle can be retried without the person repeating.
    this.sent.push(samples);
    this.session?.push(samples);
  }

  /** Everything sent for this stretch, in order, as one block. Leaves the recorder holding nothing. */
  private takeAudio(): Int16Array {
    const all = new Int16Array(this.sentSamples);
    let at = 0;
    for (const block of this.sent) {
      all.set(block, at);
      at += block.length;
    }
    this.sent = [];
    return all;
  }

  /** RMS of exactly the audio recognised for this stretch, on the same 0..1 scale as the voice detector. */
  private micLevel(): number {
    return this.sentSamples === 0 ? 0 : Math.sqrt(this.sentSquareSum / this.sentSamples);
  }

  private end(): void {
    const session = this.session;
    if (session === undefined) return;
    this.session = undefined;
    const timing: SpeechTiming = {
      ...(this.speech ?? newSpeechStart(Date.now())),
      endedAt: Date.now(),
      micLevel: this.micLevel(),
    };
    this.speech = undefined;
    const sentMs = (this.sentSamples / this.options.sampleRate) * 1000;
    const audio = this.takeAudio();
    if (this.options.onAudio !== undefined && audio.length > 0) this.options.onAudio(audio);
    if (sentMs < this.minMs) {
      session.cancel();
      this.options.onSpeechDiscarded?.(timing);
      return;
    }
    // Only report active recognition for stretches at least 500 ms long so short coughs or noise blips do not flash a transcribing badge.
    const reportRecognizing = sentMs >= 500;
    // Results are handed over in the order the speech happened, even if one takes longer to come back.
    if (reportRecognizing) {
      this.pendingRecognitions += 1;
      if (this.pendingRecognitions === 1) this.options.onRecognizing?.(true);
    }
    const settled = (): void => {
      if (!reportRecognizing) return;
      this.pendingRecognitions = Math.max(0, this.pendingRecognitions - 1);
      if (this.pendingRecognitions === 0) this.options.onRecognizing?.(false);
    };
    this.chain = this.chain
      .then(() => this.recognise(session, audio))
      .then((text) => {
        settled();
        const heard = text.trim();
        if (heard.length > 0) this.options.onText(heard, timing);
        else {
          this.options.log?.(`speech recognition heard nothing in ${Math.round(sentMs / 100) / 10} s of audio`);
          this.options.onNothing?.(timing);
        }
      })
      .catch((error: unknown) => {
        settled();
        this.options.log?.(`[stt] speech recognition failed: ${error instanceof Error ? error.message : String(error)}`);
        this.options.onFailure?.(error, timing);
      });
  }

  /**
   * Recognises one stretch, retrying it from the same audio on a throttle or transient failure.
   * Each attempt gets a fresh recogniser, so the retry never joins a dead session. Retrying stops
   * if listening was suspended, so off-the-record audio is never sent to the service.
   */
  private async recognise(first: SttSession, audio: Int16Array): Promise<string> {
    const tries = Math.max(1, this.options.recogniseTries ?? DEFAULT_RECOGNISE_TRIES);
    const backoffMs = this.options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
    const epoch = this.listeningEpoch;
    let session = first;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await session.finish();
      } catch (error) {
        const retry = isRetryableSttError(error) && attempt < tries && !this.suspended && this.listeningEpoch === epoch;
        if (!retry) throw error;
        const delayMs = backoffMs * 2 ** (attempt - 1);
        const reason = error instanceof Error ? error.message : String(error);
        this.options.log?.(`[stt] retry ${attempt + 1}/${tries} in ${delayMs} ms: ${reason}`);
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        if (this.suspended || this.listeningEpoch !== epoch) throw error;
        session = this.recognizer.start();
        session.push(audio);
      }
    }
  }
}
