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

/**
 * Puts human transcript lines back into the order the speech happened. Recognition for two people can
 * finish in any order, so a later speaker's words must wait for every earlier-started stretch to settle.
 * Nothing is guessed: a line is emitted as soon as all earlier starts have a result, a failure or a discard.
 */
export function createSpeechLineOrder<T>(emit: (line: OrderedSpeechLine<T>) => void) {
  const pending = new Map<string, Entry<T>>();
  let nextOrder = 0;
  let lastEndedAt = 0;

  function begin(start: SpeechStart): void {
    if (pending.has(start.id)) return;
    pending.set(start.id, { start, order: nextOrder, settled: false });
    nextOrder += 1;
  }

  function settle(timing: SpeechTiming, value?: T): void {
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

  return { begin, settle };
}
