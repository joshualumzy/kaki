import { parseScenario, type MeetingMemoryEntry, type MeetingSetup, type Scenario } from '@kaki/shared';
import type { MeetingHub } from './hub';
import type { MeetingPersistence } from './persist/persistence';
import type { SavedMeetingDetails, SavedMeetingPhase, StoredMeeting } from './persist/state';
import type { SeatHolder } from './rejoin';

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
  'runner:state',
  'task:',
] as const;

/** The one lifecycle state of the meeting. */
export type MeetingPhase = 'lobby' | 'starting' | 'running' | 'ended';

export interface MeetingSessionResetOptions {
  /** Shape an untouched draft's agenda for this seat; omitted uses the deterministic person seat. */
  seat?: string;
  /** Start a new identity; the first arrival into a brand-new room keeps the current one. */
  rotateIdentity?: boolean;
  /** Rotate the meeting code with the identity (default true). */
  rotateCode?: boolean;
  /** The caller already waited for the saved meeting to be cleared (New meeting). */
  savedAlreadyCleared?: boolean;
}

export interface MeetingSessionDeps {
  hub: Pick<MeetingHub, 'publishMeetingReset' | 'clearRetained'>;
  memory: MeetingMemoryEntry[];
  defaultSetup: MeetingSetup;
  /** Build the scenario a reset installs from the pack, shaped for the seat when the draft is untouched. */
  resetScenario(options: { seat?: string; draftTouched: boolean }): Scenario;
  /** The scenario the server boots with: built from the saved meeting, or the pack's. */
  restoreActive(saved: StoredMeeting): Scenario;
  /** The saved meeting to rebuild at boot, if the store had a compatible row. */
  saved?: StoredMeeting;
  /** The scenario a brand-new server boots with. */
  initialScenario: Scenario;
  /** The current identity, used when a reset keeps it (the first arrival). */
  meetingId(): string;
  /** The code clients need for the current meeting, saved with it. */
  meetingCode(): string;
  /** Move to a new identity: new id, code and role sessions, and cancel any Start in flight. */
  rotateIdentity(options: { rotateCode: boolean }): string;
  /** The holder whose seat is a person seat in the current meeting, deterministic with 2+ holders. */
  defaultSeat?(): string | undefined;
  /** Stop the empty-room grace: the meeting it belonged to is gone. */
  clearGrace(): void;
  persistence?: Pick<MeetingPersistence, 'replaceSaved'>;
}

export interface MeetingSession {
  /** The one lifecycle state: lobby, starting, running or ended. */
  phase(): MeetingPhase;
  /** The immutable scenario of the meeting now; read it through this getter every time. */
  active(): Scenario;
  /** The scenario Start sealed and is waiting to commit; only present while phase is starting. */
  candidate(): Scenario | undefined;
  /** The setup the owner is editing for the next meeting. */
  draft(): MeetingSetup;
  /** Replace the draft; an edit after a seal is the next meeting's setup, never the running one. */
  setDraft(draft: MeetingSetup): void;
  /** Whether the owner shaped the draft, or it still follows the demo pack. */
  draftTouched(): boolean;
  /** The setup Start sealed for this meeting, whether running or ended. */
  sealed(): MeetingSetup | undefined;
  /** Whether the owner edited the next draft after the seal. */
  draftEditedSinceSeal(): boolean;
  /** A saved meeting that did not come back running: the next arrival starts fresh. */
  restoredWithoutMeeting(): boolean;
  /** Who holds which seat right now; the rejoin grace reads this, never a transcript. */
  holders(): SeatHolder[];
  /** Remember a person admitted into the meeting. */
  addHolder(holder: SeatHolder): void;
  /** Forget every holder: the grace for the old meeting ended, or a new meeting starts. */
  pruneHolders(): void;
  /** The grace ended with nobody back: the running meeting is over and never resumes. */
  abandoned(): boolean;
  /** Mark a running meeting abandoned; the next arrival starts a new one. */
  abandon(): void;
  /** When the meeting started; absent until Start commits and after a reset. */
  startedAt(): string | undefined;
  setStartedAt(startedAt: string | undefined): void;
  /** Seal a scenario for a meeting about to start. Only a lobby meeting may begin a Start. */
  beginStart(candidate: Scenario, sealed: MeetingSetup): void;
  /** Swap the sealed candidate in as the active scenario. Only a starting meeting may commit. */
  commitStart(startedAt?: string): void;
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
  /** The one coherent saved shape: phase, draft, seal, holders and identity. */
  snapshot(): SavedMeetingDetails;
  /** Rebuild phase, active scenario, draft/seal and holders from one saved meeting. */
  restore(saved: StoredMeeting): void;
}

export function createMeetingSession(deps: MeetingSessionDeps): MeetingSession {
  let generation = 0;
  let phase: MeetingPhase = 'lobby';
  let active = checked(deps.initialScenario);
  let pending: Scenario | undefined;
  let pendingSealed: MeetingSetup | undefined;
  let draft = deps.defaultSetup;
  let sealedSetup: MeetingSetup | undefined;
  let draftWasTouched = false;
  let editedSinceSeal = false;
  let holders: SeatHolder[] = [];
  let started: string | undefined;
  // The grace ended with nobody back: the running meeting is over and must never resume.
  let abandonedMeeting = false;
  // The abandoned meeting came from the saved row, so replacing it is not wiping a live meeting.
  // A save that came back without a running meeting (a draft or a consumed ended meeting).
  let restoredNoMeeting = false;
  // An ended meeting keeps its seal in the saved shape until Start or reset moves on.
  let storedEnded = false;
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

  function copyHolders(saved: readonly SeatHolder[]): SeatHolder[] {
    return saved.map((holder) => ({ name: holder.name, seat: holder.seat }));
  }

  function restore(saved: StoredMeeting): void {
    if (saved.phase === 'running') {
      if (saved.sealed === undefined) throw new Error('kaki session: a running meeting has no sealed setup');
      phase = 'running';
      active = checked(deps.restoreActive(saved));
      sealedSetup = saved.sealed;
      draft = saved.draft;
      draftWasTouched = saved.draftTouched;
      editedSinceSeal = saved.draftEditedSinceSeal ?? false;
      started = saved.startedAt;
      abandonedMeeting = saved.abandoned === true;
      restoredNoMeeting = false;
      storedEnded = false;
      holders = copyHolders(saved.holders);
      return;
    }

    // A Start in flight is saved as lobby, and an ended meeting is consumed: both come back as the
    // next meeting's lobby. Its holders still let Start validate seats, but admission treats this as
    // a consumed meeting, so the next arrival starts fresh from the kept draft.
    phase = 'lobby';
    active = checked(deps.restoreActive(saved));
    started = undefined;
    abandonedMeeting = false;
    // An ended meeting keeps its consumed seal so Start can reopen it and the next arrival can drop
    // a draft that was not edited after END. A draft edited after END is the next meeting's setup.
    sealedSetup = saved.phase === 'ended' ? saved.sealed : undefined;
    if (saved.phase === 'ended' && saved.draftEditedSinceSeal !== true) {
      draft = deps.defaultSetup;
      draftWasTouched = false;
      editedSinceSeal = false;
    } else {
      draft = saved.draft;
      draftWasTouched = saved.draftTouched;
      editedSinceSeal = saved.draftEditedSinceSeal ?? false;
    }
    restoredNoMeeting = true;
    storedEnded = saved.phase === 'ended';
    holders = copyHolders(saved.holders);
  }

  function reset(options: MeetingSessionResetOptions = {}): string {
    // Shape an untouched draft for a holder before the holders are cleared for the new meeting.
    const seat = options.seat ?? deps.defaultSeat?.();
    let meetingId: string;
    if (options.rotateIdentity ?? true) {
      generation += 1;
      meetingId = deps.rotateIdentity({ rotateCode: options.rotateCode ?? true });
    } else {
      meetingId = deps.meetingId();
    }

    phase = 'lobby';
    pending = undefined;
    pendingSealed = undefined;
    abandonedMeeting = false;
    restoredNoMeeting = false;
    storedEnded = false;
    deps.memory.splice(0, deps.memory.length);

    const consumed = sealedSetup !== undefined;
    // An ended meeting keeps its seal for saving, but a draft the owner edited after END is the next
    // meeting's setup and must survive the reset; an untouched consumed draft falls back to the pack.
    const keepDraft = consumed && editedSinceSeal;
    sealedSetup = undefined;
    editedSinceSeal = false;
    if (consumed && !keepDraft) {
      draftWasTouched = false;
      draft = deps.defaultSetup;
    }
    holders = [];
    started = undefined;

    active = checked(deps.resetScenario({
      seat,
      draftTouched: draftWasTouched,
    }));

    for (const hook of hooks) {
      try {
        hook();
      } catch (error) {
        console.error('kaki session: a reset hook failed', error);
      }
    }

    for (const key of MEETING_RETAINED_KEYS) deps.hub.clearRetained(key);
    deps.clearGrace();
    if (!options.savedAlreadyCleared) replaceSavedState();

    deps.hub.publishMeetingReset({
      type: 'MEETING_RESET',
      audience: { kind: 'all' },
      payload: { meetingId },
    });
    return meetingId;
  }

  const session: MeetingSession = {
    phase: () => phase,
    active: () => active,
    candidate: () => pending,
    draft: () => draft,
    setDraft(next) {
      draft = next;
      draftWasTouched = true;
      if (sealedSetup !== undefined) editedSinceSeal = true;
    },
    draftTouched: () => draftWasTouched,
    sealed: () => sealedSetup,
    draftEditedSinceSeal: () => editedSinceSeal,
    restoredWithoutMeeting: () => restoredNoMeeting,
    holders: () => copyHolders(holders),
    addHolder(holder) {
      const name = holder.name.trim().toLowerCase();
      const seat = holder.seat.trim().toLowerCase();
      if (name === '' || seat === '') return;
      holders = holders.filter(
        (existing) =>
          existing.name.trim().toLowerCase() !== name && existing.seat.trim().toLowerCase() !== seat,
      );
      holders.push({ name, seat: holder.seat });
    },
    pruneHolders() {
      holders = [];
    },
    abandoned: () => abandonedMeeting,
    abandon() {
      if (phase !== 'running') refuse('abandon the meeting');
      abandonedMeeting = true;
    },
    startedAt: () => started,
    setStartedAt(value) {
      started = value;
    },
    beginStart(candidate, sealed) {
      if (phase !== 'lobby') refuse('begin a Start');
      pending = checked(candidate);
      pendingSealed = sealed;
      phase = 'starting';
    },
    commitStart(startedAt) {
      if (phase !== 'starting' || pending === undefined || pendingSealed === undefined) {
        refuse('commit the Start');
      }
      active = pending;
      sealedSetup = pendingSealed;
      pending = undefined;
      pendingSealed = undefined;
      editedSinceSeal = false;
      abandonedMeeting = false;
      restoredNoMeeting = false;
      storedEnded = false;
      phase = 'running';
      if (startedAt !== undefined) started = startedAt;
    },
    abortStart(reason) {
      if (phase !== 'starting') refuse('abort the Start');
      pending = undefined;
      pendingSealed = undefined;
      phase = 'lobby';
      if (reason !== '') console.warn(`kaki session: Start aborted: ${reason}`);
    },
    end() {
      if (phase !== 'running') refuse('end the meeting');
      abandonedMeeting = false;
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
    snapshot() {
      const storedPhase: SavedMeetingPhase =
        storedEnded && phase === 'lobby' ? 'ended' : phase === 'starting' ? 'lobby' : phase;
      return {
        meetingId: deps.meetingId(),
        phase: storedPhase,
        draft,
        draftTouched: draftWasTouched,
        ...(editedSinceSeal ? { draftEditedSinceSeal: true } : {}),
        ...(storedPhase === 'lobby' && !draftWasTouched
          ? { lobbyAgenda: active.agenda.map((item) => item.title) }
          : {}),
        ...(storedPhase === 'running' || storedPhase === 'ended'
          ? sealedSetup === undefined
            ? {}
            : { sealed: sealedSetup }
          : {}),
        ...(abandonedMeeting && storedPhase === 'running' ? { abandoned: true } : {}),
        holders: copyHolders(holders),
        meetingCode: deps.meetingCode(),
        ...(started === undefined ? {} : { startedAt: started }),
      };
    },
    restore,
  };

  if (deps.saved !== undefined) restore(deps.saved);
  return session;
}
