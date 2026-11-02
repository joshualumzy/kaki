/**
 * What the AI has been playing, as a loudness timeline. When the person's microphone picks up the
 * AI through their speakers it does so a moment later (network, speakers, room, network), so the
 * voice detector asks "how loud was the AI a little while ago?" to judge how much of what the
 * microphone hears is just that.
 */
export class PlaybackReference {
  private frames: Array<{ at: number; level: number }> = [];

  constructor(
    private readonly now: () => number = Date.now,
    /** The soonest the AI's sound can come back through the microphone. */
    private readonly minLagMs = 60,
    /** The latest it still can: speakers, Bluetooth and two network hops add up. */
    private readonly maxLagMs = 1200,
    /** How often a frame is recorded; tells how many frames a fully covered window has. */
    private readonly frameMs = 20,
    /** By this long after it was played, nearly all of the echo has arrived. */
    private readonly settledLagMs = 400,
  ) {}

  /** A frame of AI audio was queued with this loudness (0..1); it becomes audible `playoutInMs` from now. */
  record(level: number, playoutInMs: number): void {
    const at = this.now();
    this.frames.push({ at: at + Math.max(0, playoutInMs), level });
    const cutoff = at - 3000;
    if (this.frames[0] !== undefined && this.frames[0].at < cutoff) {
      this.frames = this.frames.filter((frame) => frame.at >= cutoff);
    }
  }

  /** The loudest AI audio that was audible between `maxLagMs` and `minLagMs` before `nowMs`; 0 if none. */
  levelAt(nowMs: number = this.now()): number {
    let loudest = 0;
    for (const frame of this.frames) {
      const age = nowMs - frame.at;
      if (age >= this.minLagMs && age <= this.maxLagMs && frame.level > loudest) loudest = frame.level;
    }
    return loudest;
  }

  /** The loudest AI audio that was audible long enough ago for its echo to have reached the microphone by now. */
  settledLevelAt(nowMs: number = this.now()): number {
    let loudest = 0;
    for (const frame of this.frames) {
      const age = nowMs - frame.at;
      if (age >= this.settledLagMs && age <= this.maxLagMs && frame.level > loudest) loudest = frame.level;
    }
    return loudest;
  }

  /**
   * The quietest AI audio in that window, but only when the AI was audible through all of it: what
   * the microphone must be hearing if it hears the AI at all. 0 when the AI only just started, or
   * paused, because then the microphone has not caught up and says nothing about leakage.
   */
  steadyLevelAt(nowMs: number = this.now()): number {
    const expected = Math.floor((this.maxLagMs - this.minLagMs) / this.frameMs);
    let count = 0;
    let quietest = Number.POSITIVE_INFINITY;
    for (const frame of this.frames) {
      const age = nowMs - frame.at;
      if (age < this.minLagMs || age > this.maxLagMs) continue;
      count += 1;
      if (frame.level < quietest) quietest = frame.level;
    }
    return count >= expected * 0.9 && Number.isFinite(quietest) ? quietest : 0;
  }
}
