import type { SpeechStart, SpeechTiming } from './utterance';

/** A settled speech line, emitted only once every line that started earlier is settled too. */
export interface OrderedSpeechLine<T> extends SpeechTiming {
  value: T;
  /** True when this person started speaking before the previous line had finished. */
  overlap: boolean;
}

interface Entry<T> {
  start: SpeechStart;
  order: number;
  timing?: SpeechTiming;
  value?: T;
  settled: boolean;
}

interface SpeechLineOrderOptions {
  /**
   * A stretch still unsettled after this long is dropped, so a lost recognition result cannot hold every later
   * speaker forever. The recogniser's own stretches are far shorter than this.
   */
  maxUnsettledMs?: number;
  log?(message: string): void;
}

/**
 * Puts human transcript lines back into the order the speech happened. Recognition for two people can
 * finish in any order, so a later speaker's words must wait for every earlier-started stretch to settle.
 * Nothing is guessed: a line is emitted as soon as all earlier starts have a result, a failure or a discard.
 */
export function createSpeechLineOrder<T>(
  emit: (line: OrderedSpeechLine<T>) => void,
  options: SpeechLineOrderOptions = {},
) {
  const pending = new Map<string, Entry<T>>();
  // Ids that must never be emitted: dropped by the timeout, or left behind by a room the meeting has left.
  const abandoned = new Set<string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const maxUnsettledMs = options.maxUnsettledMs ?? 60_000;
  let nextOrder = 0;
  let lastEndedAt = 0;

  function clearTimer(id: string): void {
    const timer = timers.get(id);
    if (timer === undefined) return;
    clearTimeout(timer);
    timers.delete(id);
  }

  function begin(start: SpeechStart): void {
    if (pending.has(start.id) || abandoned.has(start.id)) return;
    pending.set(start.id, { start, order: nextOrder, settled: false });
    nextOrder += 1;
    const timer = setTimeout(() => {
      timers.delete(start.id);
      const entry = pending.get(start.id);
      if (entry === undefined || entry.settled) return;
      pending.delete(start.id);
      abandoned.add(start.id);
      options.log?.(
        `speech order: dropped an unsettled stretch (${start.id}) after ${maxUnsettledMs} ms so it cannot block later lines`,
      );
      flush();
    }, maxUnsettledMs);
    timer.unref?.();
    timers.set(start.id, timer);
  }

  function settle(timing: SpeechTiming, value?: T): void {
    clearTimer(timing.id);
    if (abandoned.delete(timing.id)) return;
    const existing = pending.get(timing.id);
    if (existing === undefined) {
      pending.set(timing.id, { start: timing, order: nextOrder, timing, ...(value === undefined ? {} : { value }), settled: true });
      nextOrder += 1;
    } else {
      existing.timing = timing;
      if (value !== undefined) existing.value = value;
      existing.settled = true;
    }
    flush();
  }

  /** Forget every stretch from the room being left; a late result must never enter the next room's transcript. */
  function reset(): void {
    for (const id of timers.keys()) clearTimer(id);
    for (const id of pending.keys()) abandoned.add(id);
    pending.clear();
    lastEndedAt = 0;
  }

  function flush(): void {
    const ordered = [...pending.values()].sort(
      (left, right) => left.start.startedAt - right.start.startedAt || left.order - right.order,
    );
    for (const entry of ordered) {
      // An earlier stretch still being recognised: a later result must wait, not jump ahead.
      if (!entry.settled) break;
      pending.delete(entry.start.id);
      const timing = entry.timing;
      if (timing === undefined || entry.value === undefined) continue;
      const overlap = timing.startedAt < lastEndedAt;
      lastEndedAt = Math.max(lastEndedAt, timing.endedAt);
      emit({ ...timing, value: entry.value, overlap });
    }
  }

  return { begin, settle, reset };
}
