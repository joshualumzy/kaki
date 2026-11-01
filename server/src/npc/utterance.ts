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

export interface UtteranceRecorderOptions {
  sampleRate: number;
  /** Audio kept from just before the voice detector fired, so the first syllable is not lost. */
  prerollMs?: number;
  /** A stretch longer than this is cut off: it is more likely a stuck detector than a speech. */
  maxMs?: number;
  /** Shorter than this (in audio sent) is not worth recognising. */
  minMs?: number;
  /** Recognised text, in the order the speech happened. */
  onText(text: string): void;
  log?(message: string): void;
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
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly recognizer: Recognizer,
    private readonly options: UtteranceRecorderOptions,
  ) {
    this.prerollMs = options.prerollMs ?? 400;
    this.maxMs = options.maxMs ?? 25_000;
    this.minMs = options.minMs ?? 250;
  }

  /** Audio from the microphone, all of it, as it arrives. */
  push(samples: Int16Array): void {
    if (samples.length === 0) return;
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
    if (on) {
      if (this.session !== undefined) return;
      this.session = this.recognizer.start();
      this.sentSamples = 0;
      for (const block of this.preroll) this.send(block);
      this.preroll = [];
      this.prerollSamples = 0;
    } else {
      this.end();
    }
  }

  /** The person's track went away. */
  close(): void {
    this.session?.cancel();
    this.session = undefined;
  }

  private send(samples: Int16Array): void {
    this.sentSamples += samples.length;
    this.session?.push(samples);
  }

  private end(): void {
    const session = this.session;
    if (session === undefined) return;
    this.session = undefined;
    const sentMs = (this.sentSamples / this.options.sampleRate) * 1000;
    if (sentMs < this.minMs) {
      session.cancel();
      return;
    }
    // Results are handed over in the order the speech happened, even if one takes longer to come back.
    this.chain = this.chain
      .then(() => session.finish())
      .then((text) => {
        const heard = text.trim();
        if (heard.length > 0) this.options.onText(heard);
      })
      .catch((error: unknown) => this.options.log?.(`speech recognition failed: ${String(error)}`));
  }
}
