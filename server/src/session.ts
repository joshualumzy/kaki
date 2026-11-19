import { parseScenario, type MeetingMemoryEntry, type MeetingSetup, type Scenario } from '@kaki/shared';
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

/** The one lifecycle state of the meeting. */
export type MeetingPhase = 'lobby' | 'starting' | 'running' | 'ended';

/**
 * Derive the boot phase from a saved clock: the one place restore decides what a saved meeting was.
 * A meeting saved after it ended is consumed, exactly as before: the next arrival starts from the pack.
 */
export function phaseFromSaved(clock: { started?: boolean; ended?: boolean } | undefined): MeetingPhase {
  if (clock?.started !== true || clock.ended === true) return 'lobby';
  return 'running';
}

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
  /** True when the owner edited the draft after the seal, so a reset must keep it as the next draft. */
  draftEditedSinceSeal: ResetRef<boolean>;
  defaultSetup: MeetingSetup;
  /** Build the scenario a reset installs from the pack, shaped for the seat when the draft is untouched. */
  resetScenario(options: { seat?: string; draftTouched: boolean }): Scenario;
  /** The scenario the server boots with: the restored meeting's, or the pack's. */
  initialScenario: Scenario;
  /** The phase the server boots in, derived once from the saved meeting. */
  initialPhase: MeetingPhase;
  /** The current identity, used when a reset keeps it (the first arrival). */
  meetingId(): string;
  /** Move to a new identity: new id, code and role sessions, and cancel any Start in flight. */
  rotateIdentity(options: { rotateCode: boolean }): string;
  persistence?: Pick<MeetingPersistence, 'replaceSaved'>;
}

export interface MeetingSession {
  /** The one lifecycle state: lobby, starting, running or ended. */
  phase(): MeetingPhase;
  /** The immutable scenario of the meeting now; read it through this getter every time. */
  active(): Scenario;
  /** The scenario Start sealed and is waiting to commit; only present while phase is starting. */
  candidate(): Scenario | undefined;
  /** Seal a scenario for a meeting about to start. Only a lobby meeting may begin a Start. */
  beginStart(candidate: Scenario): void;
  /** Swap the sealed candidate in as the active scenario. Only a starting meeting may commit. */
  commitStart(): void;
  /** Drop the candidate and go back to lobby, leaving the active scenario untouched. */
  abortStart(reason: string): void;
  /** The meeting is over. Only a running meeting may end. */
  end(): void;
  /** The one way a meeting is reset. Returns the meeting id clients must adopt. */
  reset(options?: MeetingSessionResetOptions): string;
  /** Register per-module reset work; hooks run in registration order. */
  onReset(hook: () => void): () => void;
  /** Bumped on every new identity, so a late acknowledgement can be refused. */
  generation(): number;
}

export function createMeetingSession(deps: MeetingSessionDeps): MeetingSession {
  let generation = 0;
  let phase = deps.initialPhase;
  let active = checked(deps.initialScenario);
  let pending: Scenario | undefined;
  const hooks: Array<() => void> = [];

  function refuse(transition: string): never {
    throw new Error(`kaki session: cannot ${transition} while the meeting is ${phase}`);
  }

  /** Every scenario the session will hand to a consumer must parse; fail loudly at the source. */
  function checked(scenario: Scenario): Scenario {
    parseScenario(scenario);
    return scenario;
  }

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

    phase = 'lobby';
    pending = undefined;
    deps.memory.splice(0, deps.memory.length);

    const consumed = deps.sealedSetup.current !== undefined;
    // An ended meeting keeps its seal for saving, but a draft the owner edited after END is the next
    // meeting's setup and must survive the reset; an untouched consumed draft falls back to the pack.
    const keepDraft = consumed && deps.draftEditedSinceSeal.current;
    deps.sealedSetup.current = undefined;
    deps.draftEditedSinceSeal.current = false;
    if (consumed && !keepDraft) {
      deps.draftTouched.current = false;
      deps.setupDraft.current = deps.defaultSetup;
    }

    active = checked(deps.resetScenario({
      seat: options.seat ?? deps.rejoin.identities().at(-1)?.seat,
      draftTouched: deps.draftTouched.current,
    }));

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
    phase: () => phase,
    active: () => active,
    candidate: () => pending,
    beginStart(candidate) {
      if (phase !== 'lobby') refuse('begin a Start');
      pending = checked(candidate);
      phase = 'starting';
    },
    commitStart() {
      if (phase !== 'starting' || pending === undefined) {
        refuse('commit the Start');
      }
      active = pending;
      pending = undefined;
      phase = 'running';
    },
    abortStart(reason) {
      if (phase !== 'starting') refuse('abort the Start');
      pending = undefined;
      phase = 'lobby';
      if (reason !== '') console.warn(`kaki session: Start aborted: ${reason}`);
    },
    end() {
      if (phase !== 'running') refuse('end the meeting');
      phase = 'ended';
    },
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
