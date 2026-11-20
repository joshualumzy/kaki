import { parseScenario, type MeetingMemoryEntry, type MeetingSetup, type Scenario } from '@kaki/shared';
import type { MeetingHub } from '../core/hub';
import type { MeetingPersistence } from '../persist/persistence';
import type { SavedMeetingDetails, SavedMeetingPhase, StoredMeeting } from '../persist/state';
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
  'speech:recording',
  'task:',
] as const;

/** The one lifecycle state of the meeting. */
export type MeetingPhase = 'lobby' | 'starting' | 'running' | 'ended';

/**
 * Which journey opened the current meeting. A real meeting is the owner's; a practice meeting is
 * one anonymous visitor with the demo colleagues, and never uses the owner's draft.
 */
type MeetingKind = 'real' | 'practice';

/** The Start capability a practice join grants its one visitor, for that meeting only. */
interface PracticeGrant {
  /** The unguessable value carried by the visitor's cookie; absent when sign-in is off. */
  token?: string;
  /** The seat the practice visitor took. */
  seat: string;
  /** The meeting generation that granted it; every handoff makes it stale. */
  generation?: number;
}

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

interface MeetingSessionDeps {
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
  /**
   * A meeting handoff invalidated every credential tied to the previous generation. The app uses
   * this to close practice sockets and remove people from the room they can no longer belong to.
   * `ended` is true when the meeting itself ended: only a real meeting's room stays for the
   * minutes review. `kind` is the journey that ended, captured before the kind is cleared.
   */
  onCredentialChange?(ended: boolean, kind?: MeetingKind): void;
  persistence?: Pick<MeetingPersistence, 'replaceSaved'>;
}

export interface MeetingSession {
  /** The one lifecycle state: lobby, starting, running or ended. */
  phase(): MeetingPhase;
  /** The journey that opened this meeting, if one has been opened or joined. */
  kind(): MeetingKind | undefined;
  /** Mark the current meeting real; any practice capability ends with this call. */
  setKind(kind: MeetingKind): void;
  /** Open a practice meeting and grant its one visitor the Start capability. */
  beginPractice(grant: PracticeGrant): void;
  /** The practice visitor's Start token; undefined outside an auth-mode practice meeting. */
  practiceStartToken(): string | undefined;
  /** The generation the practice capability was granted in; a handoff makes it stale. */
  practiceGeneration(): number | undefined;
  /** The seat the practice visitor took, so their view is projected to it. */
  practiceSeat(): string | undefined;
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
  /**
   * Release a real meeting that has been verified empty, clearing its kind so practice is never
   * blocked forever. Its phase and abandonment mark stay for the restart path.
   */
  releaseRealMeeting(): void;
  /**
   * True while an ended team meeting is still being reviewed: its owner may be approving or
   * publishing the minutes. Practice may not take over and wipe it until this clears.
   */
  reviewingEndedTeamMeeting(): boolean;
  /** The owner has finished with the minutes (published or dismissed): practice may take over. */
  finishReview(): void;
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
  /**
   * Install the lobby scenario admission shaped for the first joiner's seat (the agenda pick),
   * without resetting the meeting the owner just opened. Only a lobby may be shaped.
   */
  shapeLobby(scenario: Scenario): void;
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
  // The owner's real seal and the practice meeting's own seal are separate: practice must never
  // consume the owner's draft, nor clear the mark that says it was edited after the real seal.
  let sealedSetup: MeetingSetup | undefined;
  let practiceSeal: MeetingSetup | undefined;
  let activeSealKind: MeetingKind | undefined;
  let draftWasTouched = false;
  let editedSinceSeal = false;
  let holders: SeatHolder[] = [];
  let started: string | undefined;
  let meetingKind: MeetingKind | undefined;
  let practiceGrant: PracticeGrant | undefined;
  // The grace ended with nobody back: the running meeting is over and must never resume.
  let abandonedMeeting = false;
  // The abandoned meeting came from the saved row, so replacing it is not wiping a live meeting.
  // A save that came back without a running meeting (a draft or a consumed ended meeting).
  let restoredNoMeeting = false;
  // An ended meeting keeps its seal in the saved shape until Start or reset moves on.
  let storedEnded = false;
  // A real meeting that ended is still the owner's until the minutes review is over: practice must
  // not take over and wipe its minutes, holders or room while that review is still open.
  let endedTeamReview = false;
  const hooks: Array<() => void> = [];

  function refuse(transition: string): never {
    throw new Error(`kaki session: cannot ${transition} while the meeting is ${phase}`);
  }

  /** Every scenario the session will hand to a consumer must parse; fail loudly at the source. */
  function checked(scenario: Scenario): Scenario {
    parseScenario(scenario, { requireOrganisation: false });
    return scenario;
  }

  function replaceSavedState(): void {
    deps.persistence?.replaceSaved();
  }

  function copyHolders(saved: readonly SeatHolder[]): SeatHolder[] {
    return saved.map((holder) => ({
      name: holder.name,
      seat: holder.seat,
      ...(holder.displayName === undefined ? {} : { displayName: holder.displayName }),
    }));
  }

  /** A handoff: every credential granted in the old generation must stop working. */
  function bumpGeneration(ended = false, kind?: MeetingKind): void {
    generation += 1;
    deps.onCredentialChange?.(ended, kind);
  }

  function restore(saved: StoredMeeting): void {
    // Older saved meetings predate kinds: a running meeting or a lobby people joined is a real
    // meeting. An ended one is over, so it never infers 'real' from its retained holders and
    // cannot block practice after a restart.
    const ended = saved.phase === 'ended';
    meetingKind = ended
      ? saved.kind === 'practice'
        ? 'practice'
        : undefined
      : saved.kind ??
        (saved.abandoned !== true &&
        (saved.phase === 'running' || saved.phase === 'starting' ||
          (saved.phase === 'lobby' && saved.holders.length > 0))
          ? 'real'
          : undefined);
    const restoredSealKind: MeetingKind | undefined =
      saved.sealedKind ??
      (saved.sealed === undefined
        ? undefined
        : saved.phase === 'running'
          ? saved.kind === 'practice'
            ? 'practice'
            : 'real'
          : 'real');
    practiceGrant = undefined;
    sealedSetup = undefined;
    practiceSeal = undefined;
    activeSealKind = restoredSealKind;
    // An ended team meeting is still the owner's until the review finishes; a restart must not
    // hand it to the next practice visitor while its minutes are waiting.
    endedTeamReview = ended && restoredSealKind === 'real';
    if (restoredSealKind === 'practice' && saved.sealed !== undefined) practiceSeal = saved.sealed;
    else if (saved.sealed !== undefined) sealedSetup = saved.sealed;

    if (saved.phase === 'running') {
      if (saved.sealed === undefined) throw new Error('kaki session: a running meeting has no sealed setup');
      phase = 'running';
      active = checked(deps.restoreActive(saved));
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

    // An ended real meeting whose minutes are still under review keeps its real phase, so Close,
    // the room watch and every ended-meeting rule agree after a restart. A Start in flight, a
    // consumed ended meeting, and an ended practice meeting all come back as the next meeting's
    // lobby: their holders still let Start validate seats, but admission treats them as consumed,
    // so the next arrival starts fresh from the kept draft.
    const endedReview = ended && endedTeamReview;
    phase = endedReview ? 'ended' : 'lobby';
    active = checked(deps.restoreActive(saved));
    started = endedReview ? saved.startedAt : undefined;
    abandonedMeeting = false;
    // An ended real meeting keeps its consumed seal so Start can reopen it and the next arrival can
    // drop a draft that was not edited after END. A draft edited after END is the next meeting's
    // setup. An ended practice meeting never owns the owner's draft, so it leaves it exactly as saved.
    if (ended && restoredSealKind !== 'practice' && saved.draftEditedSinceSeal !== true) {
      draft = deps.defaultSetup;
      draftWasTouched = false;
      editedSinceSeal = false;
    } else {
      draft = saved.draft;
      draftWasTouched = saved.draftTouched;
      editedSinceSeal = saved.draftEditedSinceSeal ?? false;
    }
    restoredNoMeeting = !endedReview;
    storedEnded = !endedReview && ended;
    holders = copyHolders(saved.holders);
  }

  function reset(options: MeetingSessionResetOptions = {}): string {
    // Shape an untouched draft for a holder before the holders are cleared for the new meeting.
    const seat = options.seat ?? deps.defaultSeat?.();
    let meetingId: string;
    if (options.rotateIdentity ?? true) {
      bumpGeneration();
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
    endedTeamReview = false;
    meetingKind = undefined;
    practiceGrant = undefined;
    deps.memory.splice(0, deps.memory.length);

    // Resetting a practice meeting touches only its own seal: the owner's draft, seal and edit mark
    // are exactly what they were before practice started.
    const practiceReset = activeSealKind === 'practice';
    const consumed = !practiceReset && sealedSetup !== undefined;
    // An ended meeting keeps its seal for saving, but a draft the owner edited after END is the next
    // meeting's setup and must survive the reset; an untouched consumed draft falls back to the pack.
    const keepDraft = consumed && editedSinceSeal;
    if (practiceReset) {
      practiceSeal = undefined;
    } else {
      sealedSetup = undefined;
      editedSinceSeal = false;
      if (consumed && !keepDraft) {
        draftWasTouched = false;
        draft = deps.defaultSetup;
      }
    }
    activeSealKind = undefined;
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
    kind: () => meetingKind,
    setKind(kind) {
      const changed = meetingKind !== kind;
      meetingKind = kind;
      // The practice capability belongs to a practice meeting and nowhere else.
      if (kind !== 'practice') practiceGrant = undefined;
      if (changed) bumpGeneration();
    },
    beginPractice(grant) {
      if (meetingKind !== 'practice') bumpGeneration();
      meetingKind = 'practice';
      practiceGrant = {
        seat: grant.seat,
        generation,
        ...(grant.token === undefined ? {} : { token: grant.token }),
      };
    },
    practiceStartToken: () => practiceGrant?.token,
    practiceGeneration: () => practiceGrant?.generation,
    practiceSeat: () => practiceGrant?.seat,
    active: () => active,
    candidate: () => pending,
    draft: () => draft,
    setDraft(next) {
      draft = next;
      draftWasTouched = true;
      if (sealedSetup !== undefined) editedSinceSeal = true;
    },
    draftTouched: () => draftWasTouched,
    sealed: () => (activeSealKind === 'practice' ? practiceSeal : sealedSetup),
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
      const displayName = holder.displayName?.trim() || holder.name.trim();
      holders.push({
        name,
        seat: holder.seat,
        ...(displayName === name ? {} : { displayName }),
      });
    },
    pruneHolders() {
      holders = [];
    },
    abandoned: () => abandonedMeeting,
    abandon() {
      if (phase !== 'running') refuse('abandon the meeting');
      abandonedMeeting = true;
    },
    releaseRealMeeting() {
      if (meetingKind !== 'real') return;
      meetingKind = undefined;
      practiceGrant = undefined;
      endedTeamReview = false;
      bumpGeneration();
    },
    reviewingEndedTeamMeeting: () => endedTeamReview,
    finishReview() {
      endedTeamReview = false;
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
      if (meetingKind === 'practice') {
        // Practice keeps its own seal and leaves the owner's real seal and edit mark untouched.
        practiceSeal = pendingSealed;
      } else {
        sealedSetup = pendingSealed;
        editedSinceSeal = false;
      }
      activeSealKind = meetingKind === 'practice' ? 'practice' : 'real';
      pending = undefined;
      pendingSealed = undefined;
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
      // A finished meeting is neither real nor practice until the next one is opened. Ending is a
      // handoff: every credential granted for it stops working now. The journey is captured before
      // the kind clears: a practice room must lose its people, while a real room is kept for the
      // minutes review, and that review protects it from a practice takeover.
      const endedKind = meetingKind;
      endedTeamReview = endedKind === 'real';
      meetingKind = undefined;
      practiceGrant = undefined;
      phase = 'ended';
      bumpGeneration(true, endedKind);
    },
    reset,
    shapeLobby(scenario) {
      if (phase !== 'lobby') refuse('shape the lobby scenario');
      active = checked(scenario);
      replaceSavedState();
    },
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
        ...(meetingKind === undefined ? {} : { kind: meetingKind }),
        draft,
        draftTouched: draftWasTouched,
        ...(editedSinceSeal ? { draftEditedSinceSeal: true } : {}),
        ...(storedPhase === 'lobby' && !draftWasTouched
          ? { lobbyAgenda: active.agenda.map((item) => item.title) }
          : {}),
        ...(storedPhase === 'running' || storedPhase === 'ended'
          ? activeSealKind === undefined
            ? {}
            : {
                sealed: activeSealKind === 'practice' ? practiceSeal : sealedSetup,
                sealedKind: activeSealKind,
              }
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
