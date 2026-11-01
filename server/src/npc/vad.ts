/** Tuning for the voice detector; levels are RMS on a 0..1 scale (1 = full-scale square wave). */
export interface VadOptions {
  /** Quietest level that counts as speech, however silent the room is. */
  minLevel: number;
  /** The same while the AI is talking and no playback reference is available: stricter, so leaked playback does not count. */
  guardedMinLevel: number;
  /** Speech must be this many times louder than the room's noise floor. */
  noiseRatio: number;
  guardedNoiseRatio: number;
  /** Loud audio needed before speech is declared; filters clicks and coughs. */
  startMs: number;
  guardedStartMs: number;
  /** Quiet needed before speech is declared over; bridges the pauses between words. */
  hangoverMs: number;
  /** While the AI talks, the person must be this many times louder than the AI's echo in the microphone. Lower: easier to interrupt, more risk of the AI cutting itself off. */
  leakMargin: number;
}

export const DEFAULT_VAD_OPTIONS: VadOptions = {
  minLevel: 0.015,
  guardedMinLevel: 0.02,
  noiseRatio: 4,
  guardedNoiseRatio: 6,
  startMs: 120,
  guardedStartMs: 180,
  hangoverMs: 500,
  leakMargin: 2,
};

/** What the detector needs to know about the AI's own sound. */
export interface LeakReference {
  /** How loud the AI was a little while ago, which is what could be leaking into the microphone now. */
  levelAt(nowMs: number): number;
  /**
   * How loud the AI was throughout that window, or 0 if it was not audible for all of it. The
   * leak is only measured then: just after the AI starts, the microphone has not caught up yet.
   */
  steadyLevelAt?(nowMs: number): number;
}

export interface VadDeps {
  /** With it, the bar while the AI talks follows how much of the AI the microphone really hears. */
  reference?: LeakReference;
  now?: () => number;
}

const NOISE_FLOOR_START = 0.005;
const NOISE_FLOOR_MIN = 0.001;
const NOISE_FLOOR_MAX = 0.05;
/** How fast the noise floor follows the room; small, so speech never drags it up. */
const NOISE_FLOOR_RATE = 0.05;

/** The AI is too quiet to say anything about leakage below this. */
const REFERENCE_MIN = 0.004;
/** Until it has been measured, assume the microphone hears the AI at this share of its level: cautious, but not deaf. */
const LEAK_START = 0.35;
/**
 * The leak is taken as this percentile of what was measured, not the median: samples taken before
 * the echo has come back are too low, and cutting the AI off on its own echo costs more than
 * needing to speak up a little.
 */
const LEAK_PERCENTILE = 0.75;
const LEAK_MAX = 2;
const LEAK_SAMPLES = 60;
const LEAK_MIN_SAMPLES = 20;
/** Each time the AI starts talking, the last estimate counts for this many samples: a hint, not a verdict. */
const LEAK_SEED_SAMPLES = 10;
/** Once the leak is known, a frame this many times louder than expected is a person, not leak: do not learn from it. */
const LEAK_ADMIT = 1.6;
const PEAK_MEMORY_MS = 5000;
/** Speech needs `startMs` of loud audio within this many times `startMs`: at least half of it, so syllable valleys pass. */
const START_WINDOW = 2;

/** Loudness of a block of 16-bit samples, 0..1. */
export function rmsLevel(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) sum += (sample / 32768) ** 2;
  return Math.sqrt(sum / samples.length);
}

function percentile(values: number[], share: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] ?? LEAK_START;
}

/**
 * Energy-based voice activity detection on one person's microphone track.
 *
 * That track has already had the browser's echo cancellation applied, so it carries the person's
 * voice and little of the AI's playback: that is what makes it a trustworthy signal for "the
 * person started talking over the AI". While the AI talks (`guarded`) the bar is raised. Given a
 * playback reference it measures how loud the AI is in the microphone and requires the person to
 * be clearly louder than that, so the bar suits their speakers and room; without one it falls back
 * to a fixed stricter level.
 */
export class EnergyVad {
  private guard = false;
  private speaking = false;
  private noiseFloor = NOISE_FLOOR_START;
  /** The last stretch of frames, newest last: how long each was and whether it was loud enough. */
  private window: Array<{ ms: number; loud: boolean }> = [];
  private quietMs = 0;
  private silenceTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly options: VadOptions;
  private readonly reference: LeakReference | undefined;
  private readonly now: () => number;
  private leakRatios: number[] = [];
  private lastReference = 0;
  private recent: Array<{ at: number; level: number }> = [];

  constructor(
    private readonly onChange: (speaking: boolean) => void,
    options: Partial<VadOptions> = {},
    deps: VadDeps = {},
  ) {
    this.options = { ...DEFAULT_VAD_OPTIONS, ...options };
    this.reference = deps.reference;
    this.now = deps.now ?? Date.now;
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  /** True while the AI is talking, when the bar is raised. */
  get guarded(): boolean {
    return this.guard;
  }

  set guarded(on: boolean) {
    if (on && !this.guard) {
      // A new stretch of AI talking. Speakers, volume or the person's position may have changed
      // since the last one, so the old estimate only seeds this one; it is soon outvoted.
      this.leakRatios = this.leakRatios.length >= LEAK_MIN_SAMPLES ? new Array<number>(LEAK_SEED_SAMPLES).fill(this.leakRatio) : [];
    }
    this.guard = on;
  }

  /** How loud the microphone hears the AI, as a share of how loud the AI is; learned while it talks. */
  get leakRatio(): number {
    return this.leakRatios.length >= LEAK_MIN_SAMPLES ? Math.min(LEAK_MAX, percentile(this.leakRatios, LEAK_PERCENTILE)) : LEAK_START;
  }

  /** How loud the AI was a moment ago, as the detector sees it; 0 when it is quiet or there is no reference. */
  get referenceLevel(): number {
    return this.lastReference;
  }

  /** The loudness a frame needs to count as speech right now. */
  get threshold(): number {
    return this.thresholdFor(this.lastReference);
  }

  /** The loudest the microphone has been in the last `windowMs`, for diagnosing a refused phrase. */
  peak(windowMs: number): number {
    const since = this.now() - windowMs;
    return this.recent.reduce((loudest, entry) => (entry.at >= since && entry.level > loudest ? entry.level : loudest), 0);
  }

  private thresholdFor(reference: number): number {
    const { minLevel, guardedMinLevel, noiseRatio, guardedNoiseRatio } = this.options;
    if (!this.guarded) return Math.max(minLevel, this.noiseFloor * noiseRatio);
    if (this.reference === undefined) return Math.max(guardedMinLevel, this.noiseFloor * guardedNoiseRatio);
    return Math.max(minLevel, this.noiseFloor * guardedNoiseRatio, reference * this.leakRatio * this.options.leakMargin);
  }

  /** Feed the next block of mono samples, of any length. */
  push(samples: Int16Array, sampleRate: number): void {
    if (samples.length === 0 || sampleRate <= 0) return;
    const at = this.now();
    const frameMs = (samples.length / sampleRate) * 1000;
    const level = rmsLevel(samples);

    this.recent.push({ at, level });
    while (this.recent[0] !== undefined && at - this.recent[0].at > PEAK_MEMORY_MS) this.recent.shift();

    const reference = this.guarded && this.reference !== undefined ? this.reference.levelAt(at) : 0;
    this.lastReference = reference;
    const steady = this.guarded ? (this.reference?.steadyLevelAt?.(at) ?? reference) : 0;
    if (!this.speaking && steady > REFERENCE_MIN) {
      // While the AI talks and nobody has been declared talking over it, the microphone is hearing the
      // leak. A person starting to talk over it is not the leak, so frames far louder than expected
      // are left out; otherwise the estimate would rise with their voice and talk them out of the room.
      const ratio = level / steady;
      const known = this.leakRatios.length >= LEAK_MIN_SAMPLES;
      if (!known || ratio <= this.leakRatio * LEAK_ADMIT) {
        this.leakRatios.push(ratio);
        if (this.leakRatios.length > LEAK_SAMPLES) this.leakRatios.shift();
      }
    }
    const threshold = this.thresholdFor(reference);

    // The AI's leaked sound is not the room's noise, so the floor only follows the room while the AI is quiet.
    if (!this.speaking && !this.guarded && level < threshold) {
      const target = Math.min(Math.max(level, NOISE_FLOOR_MIN), NOISE_FLOOR_MAX);
      this.noiseFloor += (target - this.noiseFloor) * NOISE_FLOOR_RATE;
    }

    if (this.speaking) {
      this.quietMs = level < threshold * 0.5 ? this.quietMs + frameMs : 0;
      if (this.quietMs >= this.options.hangoverMs) this.end();
      else this.armSilenceTimer();
      return;
    }

    // Speech starts when enough of the last stretch was loud. Counting loud time inside a window,
    // not in an unbroken run, lets the valleys between syllables pass, while a click or a cough
    // followed by quiet never adds up to enough.
    const startMs = this.guarded ? this.options.guardedStartMs : this.options.startMs;
    this.window.push({ ms: frameMs, loud: level >= threshold });
    let covered = this.window.reduce((total, frame) => total + frame.ms, 0);
    while (covered > startMs * START_WINDOW && this.window.length > 1) {
      covered -= this.window.shift()?.ms ?? 0;
    }
    const loudMs = this.window.reduce((total, frame) => (frame.loud ? total + frame.ms : total), 0);
    if (loudMs >= startMs) {
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
    this.window = [];
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
    this.window = [];
    this.quietMs = 0;
    this.onChange(false);
  }
}
