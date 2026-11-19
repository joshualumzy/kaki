import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultMeetingSetup, type KakiEvent, type MeetingMemoryEntry, type MeetingSetup, type Scenario } from '@kaki/shared';
import {
  MEETING_RETAINED_KEYS,
  createMeetingSession,
  phaseFromSaved,
  type MeetingPhase,
} from '../src/session';
import { testScenario } from './fixtures/scenario';

function copyScenario(): Scenario {
  return structuredClone(testScenario);
}

const phases: MeetingPhase[] = ['lobby', 'starting', 'running', 'ended'];

function harness({
  draftTouched = true,
  sealed = false,
  phase = 'lobby',
}: {
  draftTouched?: boolean;
  sealed?: boolean;
  phase?: MeetingPhase;
} = {}) {
  const setup: MeetingSetup = defaultMeetingSetup(testScenario);
  const initialScenario: Scenario = { ...copyScenario(), meetingTitle: 'Boot title' };
  const resetScenario: Scenario = { ...copyScenario(), meetingTitle: 'Reset title' };
  const candidate: Scenario = { ...copyScenario(), meetingTitle: 'Candidate title' };
  const memory: MeetingMemoryEntry[] = [{ kind: 'invented', item: 'Prep', text: 'Remember me.' }];
  const calls: string[] = [];
  const clearedKeys: string[] = [];
  const published: KakiEvent[] = [];
  let replaces = 0;
  const setupDraft = { current: setup };
  const sealedSetup = { current: sealed ? setup : undefined };
  const draftTouchedRef = { current: draftTouched };
  const draftEditedSinceSeal = { current: false };

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
    rejoin: {
      forgetRestored() {
        calls.push('forgetRestored');
      },
      identities() {
        return [{ name: 'Ada', seat: 'chef' }];
      },
    },
    memory,
    setupDraft,
    sealedSetup,
    draftTouched: draftTouchedRef,
    draftEditedSinceSeal,
    defaultSetup: setup,
    resetScenario(options) {
      calls.push(`resetScenario:${options.seat ?? 'none'}:${options.draftTouched}`);
      return resetScenario;
    },
    initialScenario,
    initialPhase: phase,
    meetingId: () => 'old-meeting',
    rotateIdentity({ rotateCode }) {
      calls.push(`rotate:${rotateCode}`);
      return 'new-meeting';
    },
    persistence: {
      replaceSaved() {
        replaces += 1;
      },
    },
  });

  return {
    session,
    setup,
    setupDraft,
    sealedSetup,
    draftTouched: draftTouchedRef,
    draftEditedSinceSeal,
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

describe('restored phase', () => {
  it('derives running and lobby from a saved clock in one place', () => {
    expect(phaseFromSaved(undefined)).toBe('lobby');
    expect(phaseFromSaved({ started: false, ended: false })).toBe('lobby');
    expect(phaseFromSaved({ started: true, ended: false })).toBe('running');
    expect(phaseFromSaved({ started: true, ended: true })).toBe('lobby');
  });
});

describe('meeting session phase transitions', () => {
  it('starts in the restored phase with the restored active scenario', () => {
    const h = harness({ phase: 'running' });
    expect(h.session.phase()).toBe('running');
    expect(h.session.active()).toBe(h.initialScenario);
    expect(h.session.candidate()).toBeUndefined();
  });

  it('holds a Start candidate without changing the active scenario, then swaps it in on commit', () => {
    const h = harness({ phase: 'lobby' });

    h.session.beginStart(h.candidate);

    expect(h.session.phase()).toBe('starting');
    expect(h.session.active()).toBe(h.initialScenario);
    expect(h.session.candidate()).toBe(h.candidate);

    h.session.commitStart();

    expect(h.session.phase()).toBe('running');
    expect(h.session.active()).toBe(h.candidate);
    expect(h.session.candidate()).toBeUndefined();
  });

  it('drops a Start candidate on abort and leaves the active scenario untouched', () => {
    const h = harness({ phase: 'lobby' });
    h.session.beginStart(h.candidate);

    h.session.abortStart('the runner did not answer');

    expect(h.session.phase()).toBe('lobby');
    expect(h.session.active()).toBe(h.initialScenario);
    expect(h.session.candidate()).toBeUndefined();
  });

  it('moves a running meeting to ended and keeps its active scenario', () => {
    const h = harness({ phase: 'lobby' });
    h.session.beginStart(h.candidate);
    h.session.commitStart();

    h.session.end();

    expect(h.session.phase()).toBe('ended');
    expect(h.session.active()).toBe(h.candidate);
  });

  const transitionCases: Array<{
    name: string;
    run: (session: ReturnType<typeof harness>['session'], h: ReturnType<typeof harness>) => void;
    allowedFrom: MeetingPhase;
    allowedPhase: MeetingPhase;
  }> = [
    {
      name: 'beginStart',
      run: (session, h) => session.beginStart(h.candidate),
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
    h.session.beginStart(h.candidate);
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
      if (from !== 'lobby') h.session.beginStart(h.candidate);
      if (from === 'running' || from === 'ended') h.session.commitStart();
      if (from === 'ended') h.session.end();

      h.session.reset({ seat: 'cashier' });

      expect(h.session.phase()).toBe('lobby');
      expect(h.session.active()).toBe(h.resetScenario);
      expect(h.session.candidate()).toBeUndefined();
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
      'forgetRestored',
      'publishMeetingReset',
    ]);
  });

  it('shapes an untouched draft for an explicit seat before publishing', () => {
    const h = harness({ draftTouched: false });

    h.session.reset({ seat: 'cashier' });

    expect(h.calls).toContain('resetScenario:cashier:false');
  });

  it('drops a consumed seal, but keeps a draft edited after the seal for the next meeting', () => {
    const consumed = harness({ sealed: true });
    consumed.session.reset();
    expect(consumed.setupDraft.current).toBe(consumed.setup);
    expect(consumed.draftTouched.current).toBe(false);

    const edited = harness({ sealed: true, draftTouched: true });
    const nextDraft: MeetingSetup = { ...edited.setup, title: 'Next draft' };
    edited.setupDraft.current = nextDraft;
    edited.draftEditedSinceSeal.current = true;
    edited.session.reset();
    expect(edited.setupDraft.current).toBe(nextDraft);
    expect(edited.draftTouched.current).toBe(true);
  });

  it('keeps the current identity when rotateIdentity is false, without bumping the generation', () => {
    const h = harness();

    const meetingId = h.session.reset({ rotateIdentity: false });

    expect(meetingId).toBe('old-meeting');
    expect(h.session.generation()).toBe(0);
    expect(h.calls).not.toContain('rotate:true');
  });

  it('turns a consumed sealed setup back into the default untouched draft', () => {
    const h = harness({ sealed: true });

    h.session.reset();

    expect(h.sealedSetup.current).toBeUndefined();
    expect(h.setupDraft.current).toBe(h.setup);
    expect(h.draftTouched.current).toBe(false);
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
