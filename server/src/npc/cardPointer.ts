import type { ActionKind } from '@kaki/shared';

/**
 * Remembers which agenda topics have already had their one spoken pointer at the visitor's card.
 * Every path that points at the card claims a topic here first, so a topic is pointed at once even
 * when a host cue and the review timer race each other.
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

function whoPrefix(name: string | undefined): string {
  return name === undefined || name.trim() === '' ? '' : `${name.trim()}, `;
}

/** Spoken variants picked by topic, so two topics never use the same wording. */
const FIRST_DISPATCH_LINES: ReadonlyArray<(who: string) => string> = [
  (who) => `${who}the follow-up's on your screen whenever you want to send it.`,
  (who) => `${who}the follow-up's on your screen whenever you're ready to send it.`,
  (who) => `${who}the follow-up's on your screen, so send it whenever you like.`,
  (who) => `${who}the follow-up's on your screen for you to send when you're ready.`,
];

const REPEAT_DISPATCH_LINES: ReadonlyArray<(who: string) => string> = [
  (who) => `${who}the follow-up's still on your screen whenever you're ready.`,
  (who) => `${who}the follow-up's still on your screen whenever you want to pick it up.`,
  (who) => `${who}the follow-up's still on your screen, ready when you are.`,
  (who) => `${who}the follow-up's still sitting on your screen for you.`,
];

const INVITE_LINES: ReadonlyArray<(who: string) => string> = [
  (who) => `${who}the invite's on your screen whenever you're ready to confirm it.`,
  (who) => `${who}the invite's on your screen whenever you're ready to say yes.`,
  (who) => `${who}the invite's on your screen, so confirm it whenever you like.`,
  (who) => `${who}the invite's on your screen for you to confirm when you're ready.`,
];

function lineFor(
  lines: ReadonlyArray<(who: string) => string>,
  who: string,
  seed: number | undefined,
  fallback: number,
): string {
  const index = seed === undefined ? fallback : Math.abs(Math.trunc(seed));
  return lines[index % lines.length]!(who);
}

/** The host's line when a follow-up lands on the visitor's card: the first pointer, then a brief reminder. */
export function visitorDispatchLine(name: string | undefined, count: number, topicIndex?: number): string {
  const who = whoPrefix(name);
  return count === 1
    ? lineFor(FIRST_DISPATCH_LINES, who, topicIndex, Math.max(0, count - 1))
    : lineFor(REPEAT_DISPATCH_LINES, who, topicIndex, Math.max(0, count - 2));
}

/** The first pointer at the visitor's card on a topic, naming an invite when that is what the card holds. */
export function visitorCardPointerLine(name: string | undefined, kind?: ActionKind, topicIndex?: number): string {
  if (kind === 'calendar_event') {
    return lineFor(INVITE_LINES, whoPrefix(name), topicIndex, 0);
  }
  return visitorDispatchLine(name, 1, topicIndex);
}
