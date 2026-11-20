import type { AgendaItem } from '@kaki/shared';
import type { MeetingPauseKind, SavedClockState } from '../persist/state';

export type { MeetingPauseKind } from '../persist/state';

/** Where the meeting is on its agenda right now. */
export interface ClockSnapshot {
  started: boolean;
  /** True once the meeting is over; time stands still from then on. */
  ended: boolean;
  /** True while the meeting clock is paused. */
  paused?: boolean;
  /** Why it is paused, so a restart knows whether a returning person may resume it. */
  pauseKind?: MeetingPauseKind;
  agendaIndex: number;
  /** Seconds spent on the current agenda item. */
  itemElapsedSeconds: number;
  /** Seconds since the meeting started. */
  meetingElapsedSeconds: number;
  /** True once the current item has used up its minutes. */
  overrun: boolean;
}

/** The agenda clock: knows the current item and its elapsed time, and signals overrun once per item. */
export interface AgendaClock {
  start(): void;
  /** Pause the clock; `kind` says whether a person stopped it or the room emptied. */
  pause(kind?: MeetingPauseKind): void;
  resume(): void;
  /** Back to a meeting that has not started: item 0, no time spent, overruns armed again. */
  reset(): void;
  /** Take up a saved meeting: time carries on from where it stopped, not from zero. */
  restore(saved: SavedClockState): void;
  /** Stop the meeting: time freezes and no more overruns fire. */
  end(): void;
  snapshot(): ClockSnapshot;
  /** Move forward to a later agenda item; earlier or out-of-range indexes are ignored. */
  advanceTo(index: number): void;
  /** Check for overrun now; call this on every tick. */
  tick(): void;
  /** Replace the agenda the clock times; called when a Start commits or a meeting resets. */
  setAgenda(agenda: readonly AgendaItem[]): void;
  /** The agenda the clock is timing right now. */
  agenda(): readonly AgendaItem[];
  onOverrun(handler: (agendaIndex: number, item: AgendaItem) => void): () => void;
}

/** Options for the agenda clock; `speed` runs meeting time faster than real time for replays. */
export interface AgendaClockOptions {
  agenda: AgendaItem[];
  speed?: number;
  now?: () => number;
}

/** Create an agenda clock that has not started yet. */
export function createAgendaClock({ agenda: initialAgenda, speed = 1, now = Date.now }: AgendaClockOptions): AgendaClock {
  if (!(speed > 0)) throw new Error(`Clock speed must be positive, got ${speed}`);
  let agenda = [...initialAgenda];

  let startedAt: number | undefined;
  let pausedAt: number | undefined;
  let pauseKind: MeetingPauseKind | undefined;
  let totalPausedMs = 0;
  let endedAtSeconds: number | undefined;
  let agendaIndex = 0;
  let itemStartSeconds = 0;
  const overrunFired = new Set<number>();
  const overrunHandlers = new Set<(agendaIndex: number, item: AgendaItem) => void>();

  function meetingSeconds(): number {
    if (endedAtSeconds !== undefined) return endedAtSeconds;
    if (startedAt === undefined) return 0;
    const effectiveNow = pausedAt ?? now();
    return Math.max(0, ((effectiveNow - startedAt - totalPausedMs) / 1000) * speed);
  }

  function snapshot(): ClockSnapshot {
    const meetingElapsedSeconds = meetingSeconds();
    const itemElapsedSeconds = Math.max(0, meetingElapsedSeconds - itemStartSeconds);
    const item = agenda[agendaIndex];
    return {
      started: startedAt !== undefined,
      ended: endedAtSeconds !== undefined,
      paused: pausedAt !== undefined,
      ...(pauseKind === undefined ? {} : { pauseKind }),
      agendaIndex,
      itemElapsedSeconds,
      meetingElapsedSeconds,
      overrun: item !== undefined && startedAt !== undefined && itemElapsedSeconds >= item.minutes * 60,
    };
  }

  return {
    start() {
      startedAt ??= now();
    },
    pause(kind = 'person') {
      if (startedAt === undefined || endedAtSeconds !== undefined || pausedAt !== undefined) return;
      pausedAt = now();
      pauseKind = kind;
    },
    resume() {
      if (pausedAt === undefined) return;
      totalPausedMs += Math.max(0, now() - pausedAt);
      pausedAt = undefined;
      pauseKind = undefined;
    },
    reset() {
      startedAt = undefined;
      pausedAt = undefined;
      pauseKind = undefined;
      totalPausedMs = 0;
      endedAtSeconds = undefined;
      agendaIndex = 0;
      itemStartSeconds = 0;
      overrunFired.clear();
    },
    restore(saved) {
      const elapsed = Math.max(0, saved.meetingElapsedSeconds);
      const itemElapsed = Math.max(0, Math.min(elapsed, saved.itemElapsedSeconds));
      startedAt = saved.started
        ? now() - (elapsed / speed) * 1000
        : undefined;
      pausedAt = saved.started && saved.paused && !saved.ended ? now() : undefined;
      pauseKind = pausedAt === undefined ? undefined : (saved.pauseKind ?? 'person');
      totalPausedMs = 0;
      endedAtSeconds = saved.started && saved.ended ? elapsed : undefined;
      agendaIndex = Number.isInteger(saved.agendaIndex) ? Math.max(0, saved.agendaIndex) : 0;
      itemStartSeconds = elapsed - itemElapsed;
      overrunFired.clear();
      // Do not repeat an overrun announcement for items the restarted server already covered.
      for (let index = 0; index < agendaIndex; index += 1) overrunFired.add(index);
      const item = agenda[agendaIndex];
      if (item !== undefined && itemElapsed >= item.minutes * 60) overrunFired.add(agendaIndex);
    },
    end() {
      if (startedAt !== undefined) endedAtSeconds ??= meetingSeconds();
      pausedAt = undefined;
      pauseKind = undefined;
    },
    snapshot,
    advanceTo(index) {
      if (endedAtSeconds !== undefined || !Number.isInteger(index) || index <= agendaIndex || index >= agenda.length) {
        return;
      }
      agendaIndex = index;
      itemStartSeconds = meetingSeconds();
    },
    setAgenda(next) {
      agenda = [...next];
    },
    agenda: () => agenda,
    tick() {
      const current = snapshot();
      const item = agenda[current.agendaIndex];
      if (current.ended || current.paused || !current.overrun || item === undefined || overrunFired.has(current.agendaIndex)) return;
      overrunFired.add(current.agendaIndex);
      for (const handler of overrunHandlers) {
        try {
          handler(current.agendaIndex, item);
        } catch (error) {
          console.error('kaki host: an overrun handler failed', error);
        }
      }
    },
    onOverrun(handler) {
      overrunHandlers.add(handler);
      return () => {
        overrunHandlers.delete(handler);
      };
    },
  };
}
