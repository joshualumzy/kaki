import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  defaultMeetingSetup,
  deriveMeetingScenario,
  type KakiEvent,
  type MeetingMemoryEntry,
  type MeetingSetup,
  type Scenario,
} from '@kaki/shared';
import { MEETING_RETAINED_KEYS, createMeetingSession, type MeetingPhase } from '../src/session';
import { MEETING_STATE_SCHEMA_VERSION, type StoredMeeting } from '../src/persist/state';
import { loadScenario } from '../src/loadScenario';
import { testScenario } from './fixtures/scenario';

const kopitiam = await loadScenario('kopitiam');

function copyScenario(scenario: Scenario): Scenario {
  return structuredClone(scenario);
}

function scenarioFromSetup(pack: Scenario, setup: MeetingSetup): Scenario {
  const derived = deriveMeetingScenario(pack, setup, { agendaOrder: setup.agenda.map((item) => item.title) });
  if (!derived.ok) throw new Error(derived.errors[0]?.message ?? 'the setup cannot run');
  return derived.scenario;
}

function savedMeeting({
  pack: _pack,
  phase,
  draft,
  draftTouched,
  sealed,
  draftEditedSinceSeal,
  holders = [],
}: {
  pack: Scenario;
  phase: MeetingPhase;
  draft: MeetingSetup;
  draftTouched: boolean;
  sealed?: MeetingSetup;
  draftEditedSinceSeal?: boolean;
  holders?: Array<{ name: string; seat: string }>;
}): StoredMeeting {
  const started = phase === 'running' || phase === 'ended';
  return {
    schemaVersion: MEETING_STATE_SCHEMA_VERSION,
    meetingId: 'meeting-1',
    phase,
    draft,
    draftTouched,
    ...(draftEditedSinceSeal === true ? { draftEditedSinceSeal: true } : {}),
    ...(sealed === undefined ? {} : { sealed }),
    holders,
    meetingCode: 'AB12CD',
    ...(started ? { startedAt: '2026-01-01T00:00:00.000Z' } : {}),
    savedAt: '2026-01-01T00:05:00.000Z',
    state: {
      clock: {
        started,
        ended: phase === 'ended',
        paused: false,
        agendaIndex: 0,
        itemElapsedSeconds: started ? 30 : 0,
        meetingElapsedSeconds: started ? 30 : 0,
      },
      notetaker: {
        pending: [],
        inFlight: [],
        recentGrounded: [],
        contextAgendaIndex: 0,
        agendaContext: [],
        openQuestions: [],
        questionCount: 0,
        status: 'ok',
        talkByItem: [],
        talkTotals: [],
        talkTotal: 0,
      },
      tasks: [],
    },
  };
}

const phases: MeetingPhase[] = ['lobby', 'starting', 'running', 'ended'];

function harness({
  pack = testScenario,
  draftTouched = true,
  sealed = false,
  phase = 'lobby',
  saved,
  holders = [{ name: 'ada', seat: 'chef' }],
}: {
  pack?: Scenario;
  draftTouched?: boolean;
  sealed?: boolean;
  phase?: MeetingPhase;
  saved?: StoredMeeting;
  holders?: Array<{ name: string; seat: string }>;
} = {}) {
  const setup: MeetingSetup = defaultMeetingSetup(copyScenario(pack));
  const initialScenario: Scenario = { ...copyScenario(pack), meetingTitle: 'Boot title' };
  const resetScenario: Scenario = { ...copyScenario(pack), meetingTitle: 'Reset title' };
  const candidate: Scenario = { ...copyScenario(pack), meetingTitle: 'Candidate title' };
  const memory: MeetingMemoryEntry[] = [{ kind: 'invented', item: 'Prep', text: 'Remember me.' }];
  const calls: string[] = [];
  const clearedKeys: string[] = [];
  const published: KakiEvent[] = [];
  let replaces = 0;
  const next = saved ?? {
    ...savedMeeting({ pack, phase, draft: setup, draftTouched, sealed: sealed ? setup : undefined, holders }),
  };

  const session = createMeetingSession({
    hub: {
      publishMeetingReset(event) {
        published.push(event);
        calls.push('publishMeetingReset');
      },
      clearRetained(prefix) {
        clearedKeys.push(prefix);
      },
    },
    memory,
    defaultSetup: setup,
    resetScenario(options) {
      calls.push(`resetScenario:${options.seat ?? 'none'}:${options.draftTouched}`);
      return resetScenario;
    },
    restoreActive: (savedMeeting) => scenarioFromSetup(pack, savedMeeting.sealed ?? savedMeeting.draft),
    saved: next,
    initialScenario,
    meetingId: () => 'meeting-1',
    meetingCode: () => 'AB12CD',
    rotateIdentity({ rotateCode }) {
      calls.push(`rotate:${rotateCode}`);
      return 'new-meeting';
    },
    defaultSeat: () => 'chef',
    clearGrace() {
      calls.push('clearGrace');
    },
    persistence: {
      replaceSaved() {
        replaces += 1;
      },
    },
  });

  return {
    session,
    pack,
    setup,
    memory,
    calls,
    clearedKeys,
    published,
    initialScenario,
    resetScenario,
    candidate,
    replaces: () => replaces,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('meeting session phase transitions', () => {
  it('starts in the restored phase with the restored active scenario', () => {
    const h = harness({ phase: 'running', sealed: true });
    expect(h.session.phase()).toBe('running');
    expect(h.session.active().meetingTitle).toBe(h.setup.title);
    expect(h.session.candidate()).toBeUndefined();
  });

  it('holds a Start candidate without changing the active scenario, then swaps it in on commit', () => {
    const h = harness({ phase: 'lobby' });
    const before = h.session.active();

    h.session.beginStart(h.candidate, h.setup);

    expect(h.session.phase()).toBe('starting');
    expect(h.session.active()).toBe(before);
    expect(h.session.candidate()).toBe(h.candidate);

    h.session.commitStart('2026-01-01T00:00:00.000Z');

    expect(h.session.phase()).toBe('running');
    expect(h.session.active()).toBe(h.candidate);
    expect(h.session.candidate()).toBeUndefined();
    expect(h.session.sealed()).toBe(h.setup);
    expect(h.session.startedAt()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('drops a Start candidate on abort and leaves the active scenario untouched', () => {
    const h = harness({ phase: 'lobby' });
    const before = h.session.active();
    h.session.beginStart(h.candidate, h.setup);

    h.session.abortStart('the runner did not answer');

    expect(h.session.phase()).toBe('lobby');
    expect(h.session.active()).toBe(before);
    expect(h.session.candidate()).toBeUndefined();
    expect(h.session.sealed()).toBeUndefined();
  });

  it('moves a running meeting to ended and keeps its seal and active scenario', () => {
    const h = harness({ phase: 'lobby' });
    h.session.beginStart(h.candidate, h.setup);
    h.session.commitStart();

    h.session.end();

    expect(h.session.phase()).toBe('ended');
    expect(h.session.active()).toBe(h.candidate);
    expect(h.session.sealed()).toBe(h.setup);
  });

  const transitionCases: Array<{
    name: string;
    run: (session: ReturnType<typeof harness>['session'], h: ReturnType<typeof harness>) => void;
    allowedFrom: MeetingPhase;
    allowedPhase: MeetingPhase;
  }> = [
    {
      name: 'beginStart',
      run: (session, h) => session.beginStart(h.candidate, h.setup),
      allowedFrom: 'lobby',
      allowedPhase: 'starting',
    },
    {
      name: 'commitStart',
      run: (session) => session.commitStart(),
      allowedFrom: 'starting',
      allowedPhase: 'running',
    },
    {
      name: 'abortStart',
      run: (session) => session.abortStart('test'),
      allowedFrom: 'starting',
      allowedPhase: 'lobby',
    },
    {
      name: 'end',
      run: (session) => session.end(),
      allowedFrom: 'running',
      allowedPhase: 'ended',
    },
  ];

  function moveTo(h: ReturnType<typeof harness>, target: MeetingPhase): void {
    if (target === 'lobby') return;
    h.session.beginStart(h.candidate, h.setup);
    if (target === 'starting') return;
    h.session.commitStart();
    if (target === 'running') return;
    h.session.end();
  }

  for (const transition of transitionCases) {
    for (const from of phases) {
      it(`${transition.name} from ${from} is ${from === transition.allowedFrom ? 'allowed' : 'refused loudly'}`, () => {
        const h = harness({ phase: 'lobby' });
        moveTo(h, from);

        if (from === transition.allowedFrom) {
          expect(() => transition.run(h.session, h)).not.toThrow();
          expect(h.session.phase()).toBe(transition.allowedPhase);
          return;
        }
        expect(() => transition.run(h.session, h)).toThrow(/kaki session/i);
        expect(h.session.phase()).toBe(from);
      });
    }
  }

  it('reset returns every phase to lobby and installs the reset scenario', () => {
    for (const from of phases) {
      const h = harness({ phase: 'lobby' });
      if (from !== 'lobby') h.session.beginStart(h.candidate, h.setup);
      if (from === 'running' || from === 'ended') h.session.commitStart();
      if (from === 'ended') h.session.end();

      h.session.reset({ seat: 'cashier' });

      expect(h.session.phase()).toBe('lobby');
      expect(h.session.active()).toBe(h.resetScenario);
      expect(h.session.candidate()).toBeUndefined();
      expect(h.session.holders()).toEqual([]);
    }
  });
});

describe('meeting session reset', () => {
  it('clears every retained meeting key in one place', () => {
    expect(MEETING_RETAINED_KEYS).toEqual([
      'meeting:started',
      'record',
      'host:opening',
      'fact:',
      'nudge:',
      'meeting:restored',
      'runner:state',
      'task:',
    ]);
  });

  it('runs the fixed order once, publishes one reset, and returns the new meeting id', () => {
    const h = harness();
    h.session.onReset(() => h.calls.push('hook:first'));
    h.session.onReset(() => h.calls.push('hook:second'));

    const meetingId = h.session.reset({ seat: 'chef' });

    expect(meetingId).toBe('new-meeting');
    expect(h.session.generation()).toBe(1);
    expect(h.memory).toEqual([]);
    expect(h.clearedKeys).toEqual([...MEETING_RETAINED_KEYS]);
    expect(h.published).toHaveLength(1);
    expect(h.published[0]).toMatchObject({ type: 'MEETING_RESET', payload: { meetingId: 'new-meeting' } });
    expect(h.replaces()).toBe(1);
    expect(h.calls).toEqual([
      'rotate:true',
      'resetScenario:chef:true',
      'hook:first',
      'hook:second',
      'clearGrace',
      'publishMeetingReset',
    ]);
  });

  it('shapes an untouched draft for the deterministic person seat before publishing', () => {
    const h = harness({ draftTouched: false });

    h.session.reset();

    expect(h.calls).toContain('resetScenario:chef:false');
  });

  it('drops a consumed seal, but keeps a draft edited after the seal for the next meeting', () => {
    const consumed = harness({ sealed: true, phase: 'running' });
    consumed.session.reset();
    expect(consumed.session.draft()).toBe(consumed.setup);
    expect(consumed.session.draftTouched()).toBe(false);

    const edited = harness({ sealed: true, phase: 'running', draftTouched: true });
    const nextDraft: MeetingSetup = { ...edited.setup, title: 'Next draft' };
    edited.session.setDraft(nextDraft);
    edited.session.reset();
    expect(edited.session.draft()).toBe(nextDraft);
    expect(edited.session.draftTouched()).toBe(true);
  });

  it('keeps the current identity when rotateIdentity is false, without bumping the generation', () => {
    const h = harness();

    const meetingId = h.session.reset({ rotateIdentity: false });

    expect(meetingId).toBe('meeting-1');
    expect(h.session.generation()).toBe(0);
    expect(h.calls).not.toContain('rotate:true');
  });

  it('turns a consumed sealed setup back into the default untouched draft', () => {
    const h = harness({ sealed: true, phase: 'running' });

    h.session.reset();

    expect(h.session.sealed()).toBeUndefined();
    expect(h.session.draft()).toBe(h.setup);
    expect(h.session.draftTouched()).toBe(false);
  });

  it('asks persistence to replace the saved meeting on a committed reset', () => {
    const h = harness();

    h.session.reset();

    expect(h.replaces()).toBe(1);
  });

  it('does not touch the saved meeting again when the caller already waited for the clear', () => {
    const h = harness();

    h.session.reset({ savedAlreadyCleared: true });

    expect(h.replaces()).toBe(0);
  });
});

describe('meeting session snapshot and restore', () => {
  it('round-trips a lobby draft that is untouched', () => {
    const h = harness({ phase: 'lobby', draftTouched: false });
    const snap = h.session.snapshot();

    expect(snap).toMatchObject({
      meetingId: 'meeting-1',
      phase: 'lobby',
      draftTouched: false,
      holders: [{ name: 'ada', seat: 'chef' }],
      meetingCode: 'AB12CD',
    });
    expect(snap.sealed).toBeUndefined();
    expect(snap.startedAt).toBeUndefined();
    expect(snap.draft).toBe(h.setup);

    const restored = createMeetingSession({
      ...basicDeps(h),
      saved: { ...snap, schemaVersion: MEETING_STATE_SCHEMA_VERSION, savedAt: '2026-01-01T00:00:00.000Z', state: emptyState() },
    });
    expect(restored.phase()).toBe('lobby');
    expect(restored.draft()).toEqual(h.setup);
    expect(restored.sealed()).toBeUndefined();
    expect(restored.restoredWithoutMeeting()).toBe(true);
    expect(restored.snapshot()).toEqual(snap);
  });

  it('round-trips an edited lobby draft', () => {
    const h = harness({ phase: 'lobby' });
    const edited: MeetingSetup = { ...h.setup, title: 'Edited lobby draft' };
    h.session.setDraft(edited);
    const snap = h.session.snapshot();

    expect(snap.phase).toBe('lobby');
    expect(snap.draft).toEqual(edited);
    expect(snap.draftTouched).toBe(true);

    const restored = createMeetingSession({
      ...basicDeps(h),
      saved: { ...snap, schemaVersion: MEETING_STATE_SCHEMA_VERSION, savedAt: '2026-01-01T00:00:00.000Z', state: emptyState() },
    });
    expect(restored.phase()).toBe('lobby');
    expect(restored.draft()).toEqual(edited);
    expect(restored.draftTouched()).toBe(true);
  });

  it('saves a Start in flight as lobby with the draft, never as running', () => {
    const h = harness({ phase: 'lobby' });
    h.session.beginStart(h.candidate, h.setup);

    const snap = h.session.snapshot();

    expect(snap.phase).toBe('lobby');
    expect(snap.sealed).toBeUndefined();
    expect(snap.startedAt).toBeUndefined();
    expect(snap.draft).toBe(h.session.draft());
  });

  it('round-trips a running meeting with its seal and its saved start time', () => {
    const h = harness({ phase: 'running', sealed: true, draftTouched: true });
    const snap = h.session.snapshot();

    expect(snap.phase).toBe('running');
    expect(snap.sealed).toBe(h.setup);
    expect(snap.startedAt).toBe('2026-01-01T00:00:00.000Z');

    const restored = createMeetingSession({
      ...basicDeps(h),
      saved: { ...snap, schemaVersion: MEETING_STATE_SCHEMA_VERSION, savedAt: '2026-01-01T00:00:00.000Z', state: emptyState() },
    });
    expect(restored.phase()).toBe('running');
    expect(restored.sealed()).toEqual(h.setup);
    expect(restored.draft()).toEqual(snap.draft);
    expect(restored.startedAt()).toBe('2026-01-01T00:00:00.000Z');
    expect(restored.active().agenda.map((item) => item.title)).toEqual(h.setup.agenda.map((item) => item.title));
  });

  it('restores a running meeting agenda in the sealed order, so the clock index still resolves', () => {
    const h = harness({ phase: 'running', sealed: true });
    const sealed = structuredClone(h.setup);
    sealed.agenda = [...sealed.agenda].reverse();
    const saved = savedMeeting({
      pack: h.pack,
      phase: 'running',
      draft: h.setup,
      draftTouched: true,
      sealed,
      holders: [{ name: 'ada', seat: 'chef' }],
    });

    const restored = createMeetingSession({ ...basicDeps(h), saved });

    expect(restored.active().agenda.map((item) => item.title)).toEqual(sealed.agenda.map((item) => item.title));
    expect(restored.snapshot().sealed).toEqual(sealed);
  });

  it('round-trips an abandoned meeting and clears the mark on reset', () => {
    const h = harness({ phase: 'running', sealed: true });
    h.session.abandon();
    expect(h.session.phase()).toBe('running');
    expect(h.session.abandoned()).toBe(true);
    const snap = h.session.snapshot();
    expect(snap.abandoned).toBe(true);

    const restored = createMeetingSession({
      ...basicDeps(h),
      saved: { ...snap, schemaVersion: MEETING_STATE_SCHEMA_VERSION, savedAt: '2026-01-01T00:00:00.000Z', state: emptyState() },
    });
    expect(restored.abandoned()).toBe(true);

    restored.reset();
    expect(restored.abandoned()).toBe(false);
  });

  it('saves the active lobby agenda without marking the draft as owner-edited', () => {
    const h = harness({ phase: 'lobby', draftTouched: false });
    const snap = h.session.snapshot();

    expect(snap.phase).toBe('lobby');
    expect(snap.draftTouched).toBe(false);
    expect(snap.lobbyAgenda).toEqual(h.session.active().agenda.map((item) => item.title));

    const restored = createMeetingSession({
      ...basicDeps(h),
      saved: { ...snap, schemaVersion: MEETING_STATE_SCHEMA_VERSION, savedAt: '2026-01-01T00:00:00.000Z', state: emptyState() },
    });
    expect(restored.draftTouched()).toBe(false);
    expect(restored.snapshot().lobbyAgenda).toEqual(snap.lobbyAgenda);
  });

  it('consumes an ended meeting but keeps a draft edited after the seal', () => {
    const h = harness({ phase: 'running', sealed: true, draftTouched: true });
    const nextDraft: MeetingSetup = {
      ...h.setup,
      title: 'Next draft after end',
      agenda: h.setup.agenda.map((item) => ({ ...item, title: `${item.title} next` })),
    };
    h.session.setDraft(nextDraft);
    h.session.end();
    const snap = h.session.snapshot();

    expect(snap.phase).toBe('ended');
    expect(snap.sealed).toEqual(h.setup);
    expect(snap.draft).toEqual(nextDraft);

    const restored = createMeetingSession({
      ...basicDeps(h),
      saved: { ...snap, schemaVersion: MEETING_STATE_SCHEMA_VERSION, savedAt: '2026-01-01T00:00:00.000Z', state: emptyState() },
    });
    expect(restored.phase()).toBe('lobby');
    expect(restored.restoredWithoutMeeting()).toBe(true);
    expect(restored.sealed()).toEqual(h.setup);
    expect(restored.draft()).toEqual(nextDraft);
    expect(restored.draftTouched()).toBe(true);
    expect(restored.snapshot().phase).toBe('ended');

    restored.reset();
    expect(restored.draft()).toEqual(nextDraft);
  });

  it('consumes an ended meeting untouched draft back to the pack default', () => {
    const h = harness({ phase: 'lobby', draftTouched: true });
    const editedBeforeStart: MeetingSetup = { ...h.setup, title: 'Edited before Start' };
    h.session.setDraft(editedBeforeStart);
    h.session.beginStart(h.candidate, editedBeforeStart);
    h.session.commitStart();
    h.session.end();
    const snap = h.session.snapshot();

    expect(snap.phase).toBe('ended');
    expect(snap.draftEditedSinceSeal).toBeUndefined();

    const restored = createMeetingSession({
      ...basicDeps(h),
      saved: { ...snap, schemaVersion: MEETING_STATE_SCHEMA_VERSION, savedAt: '2026-01-01T00:00:00.000Z', state: emptyState() },
    });
    expect(restored.phase()).toBe('lobby');
    expect(restored.draft()).toEqual(h.setup);
    expect(restored.draftTouched()).toBe(false);
    restored.reset();
    expect(restored.draft()).toEqual(h.setup);
  });

  it('round-trips every phase with the real Kopitiam pack', () => {
    const cases: Array<'lobby' | 'starting' | 'running' | 'ended'> = ['lobby', 'starting', 'running', 'ended'];
    for (const phase of cases) {
      const h = harness({ pack: kopitiam, phase: 'lobby' });
      const sealed: MeetingSetup = { ...h.setup, title: `Kopitiam ${phase}` };
      const edited: MeetingSetup = { ...sealed, title: `Kopitiam ${phase} next` };
      if (phase === 'lobby') h.session.setDraft(edited);
      if (phase === 'starting') {
        h.session.setDraft(edited);
        h.session.beginStart(h.candidate, edited);
      }
      if (phase === 'running' || phase === 'ended') {
        h.session.beginStart(h.candidate, sealed);
        h.session.commitStart('2026-01-01T00:00:00.000Z');
      }
      if (phase === 'ended') {
        h.session.setDraft(edited);
        h.session.end();
      }
      const snap = h.session.snapshot();
      const restored = createMeetingSession({
        ...basicDeps(h),
        saved: {
          ...snap,
          schemaVersion: MEETING_STATE_SCHEMA_VERSION,
          savedAt: '2026-01-01T00:00:00.000Z',
          state: emptyState(),
        },
      });
      expect(restored.phase()).toBe(phase === 'starting' || phase === 'ended' ? 'lobby' : phase);
      expect(restored.snapshot().phase).toBe(phase === 'starting' ? 'lobby' : phase);
      expect(restored.snapshot().draft).toEqual(snap.draft);
      if (phase === 'running') {
        expect(restored.active().agenda.map((item) => item.title)).toEqual(
          sealed.agenda.map((item) => item.title),
        );
      }
    }
  });
});

function emptyState(): StoredMeeting['state'] {
  return {
    clock: {
      started: true,
      ended: false,
      paused: false,
      agendaIndex: 0,
      itemElapsedSeconds: 0,
      meetingElapsedSeconds: 0,
    },
    notetaker: {
      pending: [],
      inFlight: [],
      recentGrounded: [],
      contextAgendaIndex: 0,
      agendaContext: [],
      openQuestions: [],
      questionCount: 0,
      status: 'ok',
      talkByItem: [],
      talkTotals: [],
      talkTotal: 0,
    },
    tasks: [],
  };
}

function basicDeps(h: ReturnType<typeof harness>) {
  return {
    hub: {
      publishMeetingReset() {},
      clearRetained() {},
    },
    memory: [],
    defaultSetup: h.setup,
    resetScenario: () => h.resetScenario,
    restoreActive: (savedMeeting: StoredMeeting) =>
      scenarioFromSetup(h.pack, savedMeeting.sealed ?? savedMeeting.draft),
    initialScenario: h.initialScenario,
    meetingId: () => 'meeting-1',
    meetingCode: () => 'AB12CD',
    rotateIdentity: () => 'new-meeting',
    defaultSeat: () => 'chef',
    clearGrace() {},
  };
}

describe('server reset sources', () => {
  function serverSources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return serverSources(path);
      return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
    });
  }

  it('never swallows a clearSaved failure', () => {
    const root = fileURLToPath(new URL('../src', import.meta.url));
    const swallowed = /clearSaved\(\)\s*\.catch\(\s*\(\s*\)\s*=>\s*undefined\s*\)/;
    for (const file of serverSources(root)) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(swallowed);
    }
  });
});
