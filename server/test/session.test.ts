import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultMeetingSetup, type KakiEvent, type MeetingMemoryEntry, type MeetingSetup, type Scenario } from '@kaki/shared';
import { MEETING_RETAINED_KEYS, createMeetingSession } from '../src/session';
import { testScenario } from './fixtures/scenario';

function copyScenario(): Scenario {
  return structuredClone(testScenario);
}

function harness({
  failClear = false,
  draftTouched = true,
  sealed = false,
}: {
  failClear?: boolean;
  draftTouched?: boolean;
  sealed?: boolean;
} = {}) {
  const setup: MeetingSetup = defaultMeetingSetup(testScenario);
  const scenario = copyScenario();
  const fullScenario = copyScenario();
  const memory: MeetingMemoryEntry[] = [{ kind: 'invented', item: 'Prep', text: 'Remember me.' }];
  const calls: string[] = [];
  const clearedKeys: string[] = [];
  const published: KakiEvent[] = [];
  let clears = 0;
  let saves = 0;
  const setupDraft = { current: setup };
  const sealedSetup = { current: sealed ? setup : undefined };
  const draftTouchedRef = { current: draftTouched };

  const session = createMeetingSession({
    hub: {
      publish(event) {
        published.push(event);
        calls.push('publish');
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
    defaultSetup: setup,
    scenario,
    fullScenario,
    meetingId: () => 'old-meeting',
    rotateIdentity({ rotateCode }) {
      calls.push(`rotate:${rotateCode}`);
      return 'new-meeting';
    },
    restoreScenarioFields() {
      calls.push('restoreScenario');
    },
    setPackAgenda() {
      calls.push('setPackAgenda');
    },
    shapeUntouchedAgenda(seat) {
      calls.push(`shape:${seat ?? 'none'}`);
    },
    persistence: {
      async clearSaved() {
        clears += 1;
        if (failClear) throw new Error('database is down');
      },
      scheduleSave() {
        saves += 1;
      },
    },
  });

  return {
    session,
    setup,
    setupDraft,
    sealedSetup,
    draftTouched: draftTouchedRef,
    memory,
    calls,
    clearedKeys,
    published,
    clears: () => clears,
    saves: () => saves,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
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
    expect(h.session.ownsResetEvent(h.published[0]!)).toBe(false);
    expect(h.calls).toEqual([
      'rotate:true',
      'restoreScenario',
      'setPackAgenda',
      'hook:first',
      'hook:second',
      'forgetRestored',
      'publish',
    ]);
  });

  it('shapes an untouched draft for an explicit seat before publishing', () => {
    const h = harness({ draftTouched: false });

    h.session.reset({ seat: 'cashier' });

    expect(h.calls).toContain('shape:cashier');
    expect(h.calls).not.toContain('setPackAgenda');
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

  it('logs a failed saved-state clear loudly and schedules the next save to overwrite it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const h = harness({ failClear: true });

    h.session.reset();
    await Promise.resolve();
    await Promise.resolve();

    expect(error).toHaveBeenCalledWith(expect.stringContaining('database is down'));
    expect(h.saves()).toBe(1);
  });

  it('does not clear the saved meeting again when the caller already waited for it', () => {
    const h = harness();

    h.session.reset({ savedAlreadyCleared: true });

    expect(h.clears()).toBe(0);
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
