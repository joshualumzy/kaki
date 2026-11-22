/**
 * Remembers which agenda topics have already had the visitor's follow-up card pointed out. Kaki's pop-up does the
 * pointing; Sam never says it. Every path claims a topic here first, so a host cue and the review timer that race
 * each other record it once.
 */
export class CardPointer {
  private readonly pointed = new Set<string>();

  hasPointed(topic: string | undefined): boolean {
    return topic !== undefined && this.pointed.has(topic);
  }

  /** Claim the single pointer for a topic. False means another path already pointed at it. */
  claim(topic: string | undefined): boolean {
    if (topic === undefined || this.pointed.has(topic)) return false;
    this.pointed.add(topic);
    return true;
  }

  /** Give the claim back when the line was never spoken, so a later path can still point. */
  release(topic: string | undefined): void {
    if (topic !== undefined) this.pointed.delete(topic);
  }

  clear(): void {
    this.pointed.clear();
  }
}
