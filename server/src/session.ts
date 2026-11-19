import type { MeetingMemoryEntry, MeetingSetup, Scenario } from '@kaki/shared';
import type { MeetingHub } from './hub';
import type { MeetingPersistence } from './persist/persistence';
import type { RejoinGuard } from './rejoin';

/**
 * Every retained hub key that belongs to one meeting. A reset clears exactly this list; no other
 * module carries its own copy.
 */
export const MEETING_RETAINED_KEYS = [
  'meeting:started',
  'record',
  'host:opening',
  'fact:',
  'nudge:',
  'meeting:restored',
  'task:',
] as const;

export interface MeetingSessionResetOptions {
  /** Shape an untouched draft's agenda for this seat; omitted uses the last seat holder. */
  seat?: string;
  /** Start a new identity; the first arrival into a brand-new room keeps the current one. */
  rotateIdentity?: boolean;
  /** Rotate the meeting code with the identity (default true). */
  rotateCode?: boolean;
  /** The caller already waited for the saved meeting to be cleared (New meeting). */
  savedAlreadyCleared?: boolean;
}

interface ResetRef<T> {
  current: T;
}

export interface MeetingSessionDeps {
  hub: Pick<MeetingHub, 'publishMeetingReset' | 'clearRetained'>;
  rejoin: Pick<RejoinGuard, 'forgetRestored' | 'identities'>;
  memory: MeetingMemoryEntry[];
  setupDraft: ResetRef<MeetingSetup>;
  sealedSetup: ResetRef<MeetingSetup | undefined>;
  draftTouched: ResetRef<boolean>;
  defaultSetup: MeetingSetup;
  scenario: Scenario;
  fullScenario: Scenario;
  /** The current identity, used when a reset keeps it (the first arrival). */
  meetingId(): string;
  /** Move to a new identity: new id, code and role sessions, and cancel any Start in flight. */
  rotateIdentity(options: { rotateCode: boolean }): string;
  /** Put the meeting's title, roles and cast back to the whole pack. */
  restoreScenarioFields(): void;
  /** Set the pack's full agenda, for an owner-touched draft. */
  setPackAgenda(): void;
  /** Shape an untouched draft's agenda for a seat, or the pack order when there is none. */
  shapeUntouchedAgenda(seat: string | undefined): void;
  persistence?: Pick<MeetingPersistence, 'replaceSaved'>;
}

export interface MeetingSession {
  /** The one way a meeting is reset. Returns the meeting id clients must adopt. */
  reset(options?: MeetingSessionResetOptions): string;
  /** Register per-module reset work; hooks run in registration order. */
  onReset(hook: () => void): () => void;
  /** Bumped on every new identity, so a late acknowledgement can be refused. */
  generation(): number;
}

export function createMeetingSession(deps: MeetingSessionDeps): MeetingSession {
  let generation = 0;
  const hooks: Array<() => void> = [];

  function replaceSavedState(): void {
    deps.persistence?.replaceSaved();
  }

  function reset(options: MeetingSessionResetOptions = {}): string {
    let meetingId: string;
    if (options.rotateIdentity ?? true) {
      generation += 1;
      meetingId = deps.rotateIdentity({ rotateCode: options.rotateCode ?? true });
    } else {
      meetingId = deps.meetingId();
    }

    deps.memory.splice(0, deps.memory.length);

    const consumed = deps.sealedSetup.current !== undefined;
    deps.sealedSetup.current = undefined;
    if (consumed) {
      deps.draftTouched.current = false;
      deps.setupDraft.current = deps.defaultSetup;
    }

    deps.restoreScenarioFields();
    if (deps.draftTouched.current) deps.setPackAgenda();
    else deps.shapeUntouchedAgenda(options.seat ?? deps.rejoin.identities().at(-1)?.seat);

    for (const hook of hooks) {
      try {
        hook();
      } catch (error) {
        console.error('kaki session: a reset hook failed', error);
      }
    }

    for (const key of MEETING_RETAINED_KEYS) deps.hub.clearRetained(key);
    deps.rejoin.forgetRestored();
    if (!options.savedAlreadyCleared) replaceSavedState();

    deps.hub.publishMeetingReset({
      type: 'MEETING_RESET',
      audience: { kind: 'all' },
      payload: { meetingId },
    });
    return meetingId;
  }

  return {
    reset,
    onReset(hook) {
      hooks.push(hook);
      return () => {
        const index = hooks.indexOf(hook);
        if (index >= 0) hooks.splice(index, 1);
      };
    },
    generation: () => generation,
  };
}
