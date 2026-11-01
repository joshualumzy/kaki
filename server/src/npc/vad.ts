/** Tuning for the voice detector; levels are RMS on a 0..1 scale (1 = full-scale square wave). */
export interface VadOptions {
  /** Quietest level that counts as speech, however silent the room is. */
  minLevel: number;
  /** The same, while the AI is talking: stricter, so leaked playback does not count as a person. */
  guardedMinLevel: number;
  /** Speech must be this many times louder than the room's noise floor. */
  noiseRatio: number;
  guardedNoiseRatio: number;
  /** Loud audio needed before speech is declared; filters clicks and coughs. */
  startMs: number;
  guardedStartMs: number;
  /** Quiet needed before speech is declared over; bridges the pauses between words. */
  hangoverMs: number;
}

export const DEFAULT_VAD_OPTIONS: VadOptions = {
  minLevel: 0.015,
  guardedMinLevel: 0.03,
  noiseRatio: 4,
  guardedNoiseRatio: 6,
  startMs: 120,
  guardedStartMs: 250,
  hangoverMs: 500,
};

const NOISE_FLOOR_START = 0.005;
const NOISE_FLOOR_MIN = 0.001;
const NOISE_FLOOR_MAX = 0.05;
/** How fast the noise floor follows the room; small, so speech never drags it up. */
const NOISE_FLOOR_RATE = 0.05;

function rms(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) sum += (sample / 32768) ** 2;
  return Math.sqrt(sum / samples.length);
}

/**
 * Energy-based voice activity detection on one person's microphone track.
 *
 * That track has already had the browser's echo cancellation applied, so it carries the person's
 * voice and little of the AI's playback: that is what makes it a trustworthy signal for "the
 * person started talking over the AI". `guarded` raises the bar while the AI is speaking.
 */
export class EnergyVad {
  guarded = false;
  private speaking = false;
  private noiseFloor = NOISE_FLOOR_START;
  private loudMs = 0;
  private quietMs = 0;
  private silenceTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly options: VadOptions;

  constructor(
    private readonly onChange: (speaking: boolean) => void,
    options: Partial<VadOptions> = {},
  ) {
    this.options = { ...DEFAULT_VAD_OPTIONS, ...options };
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  /** The loudness a frame needs to count as speech right now. */
  get threshold(): number {
    const { minLevel, guardedMinLevel, noiseRatio, guardedNoiseRatio } = this.options;
    return this.guarded
      ? Math.max(guardedMinLevel, this.noiseFloor * guardedNoiseRatio)
      : Math.max(minLevel, this.noiseFloor * noiseRatio);
  }

  /** Feed the next block of mono samples, of any length. */
  push(samples: Int16Array, sampleRate: number): void {
    if (samples.length === 0 || sampleRate <= 0) return;
    const frameMs = (samples.length / sampleRate) * 1000;
    const level = rms(samples);
    const threshold = this.threshold;

    if (!this.speaking && level < threshold) {
      const target = Math.min(Math.max(level, NOISE_FLOOR_MIN), NOISE_FLOOR_MAX);
      this.noiseFloor += (target - this.noiseFloor) * NOISE_FLOOR_RATE;
    }

    if (this.speaking) {
      this.quietMs = level < threshold * 0.5 ? this.quietMs + frameMs : 0;
      if (this.quietMs >= this.options.hangoverMs) this.end();
      else this.armSilenceTimer();
      return;
    }

    // Quiet frames drain the count twice as fast as loud ones fill it, so one pause does not
    // reset speech that is just starting, but a click followed by silence never adds up.
    this.loudMs = level >= threshold ? this.loudMs + frameMs : Math.max(0, this.loudMs - 2 * frameMs);
    const startMs = this.guarded ? this.options.guardedStartMs : this.options.startMs;
    if (this.loudMs >= startMs) {
      this.speaking = true;
      this.quietMs = 0;
      this.armSilenceTimer();
      this.onChange(true);
    }
  }

  /** Forget everything, for example when the person's track goes away. */
  close(): void {
    if (this.silenceTimer !== undefined) clearTimeout(this.silenceTimer);
    this.silenceTimer = undefined;
    if (this.speaking) this.end();
    this.loudMs = 0;
  }

  // Opus can stop sending packets altogether during silence, so quiet is not always visible as
  // quiet frames: if nothing arrives for the hangover time, the person has stopped.
  private armSilenceTimer(): void {
    if (this.silenceTimer !== undefined) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => this.end(), this.options.hangoverMs);
  }

  private end(): void {
    if (this.silenceTimer !== undefined) clearTimeout(this.silenceTimer);
    this.silenceTimer = undefined;
    if (!this.speaking) return;
    this.speaking = false;
    this.loudMs = 0;
    this.quietMs = 0;
    this.onChange(false);
  }
}
