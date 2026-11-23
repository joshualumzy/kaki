import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMeetingRegistry,
  createMemoryMeetingStore,
  MeetingBusyError,
  PracticeFullError,
  type MeetingStore,
} from '../../src/meeting/registry';
import type { MeetingInstance } from '../../src/meeting/instance';
import type { MeetingRow } from '../../src/meeting/types';

function fakeInstance(
  id: string,
  kind: 'real' | 'practice',
  overrides: { phase?: 'lobby' | 'starting' | 'running' | 'ended'; people?: number; lastActivityAt?: number } = {},
): MeetingInstance & { disposed: () => boolean } {
  let disposed = false;
  const phase = overrides.phase ?? 'lobby';
  const instance = {
    id,
    workspaceId: 'sample',
    runnerKind: kind,
    session: { phase: () => phase },
    roomName: `kaki-${id}`,
    lastActivityAt: () => overrides.lastActivityAt ?? 0,
    connectedPeople: () => overrides.people ?? 0,
    meetingCode: () => 'CODE',
    dispose: async () => {
      disposed = true;
    },
    disposed: () => disposed,
  };
  return instance as unknown as MeetingInstance & { disposed: () => boolean };
}

function row(id: string): MeetingRow {
  return {
    id,
    workspaceId: 'sample',
    ownerUserId: 'owner-1',
    title: 'Team meeting',
    kind: 'real',
    status: 'open',
    scheduledFor: null,
    agenda: [],
    createdAt: new Date(0).toISOString(),
    endedAt: null,
  };
}

interface Built {
  registry: ReturnType<typeof createMeetingRegistry>;
  store: MeetingStore & { rows: Map<string, MeetingRow> };
  instances: Map<string, MeetingInstance & { disposed: () => boolean }>;
  builtIds: string[];
  closed: string[];
  opened: string[];
}

function build(options: {
  now?: () => number;
  maxOpen?: number;
  maxPractice?: number;
  unloadMs?: number;
  practiceUnloadMs?: number;
  sweepMs?: number;
  failPracticeBuild?: boolean;
} = {}): Built {
  const store = createMemoryMeetingStore();
  store.rows.set('real-1', row('real-1'));
  const instances = new Map<string, MeetingInstance & { disposed: () => boolean }>();
  const builtIds: string[] = [];
  const closed: string[] = [];
  const opened: string[] = [];
  const registry = createMeetingRegistry({
    legacy: fakeInstance('meeting', 'practice'),
    store,
    buildInstance: async (meetingRow) => {
      const instance = fakeInstance(meetingRow.id, 'real');
      instances.set(instance.id, instance);
      return instance;
    },
    buildPracticeInstance: async (id) => {
      if (options.failPracticeBuild) throw new Error('build failed');
      builtIds.push(id);
      const instance = fakeInstance(id, 'practice', {
        ...(options.now === undefined ? {} : { lastActivityAt: options.now() }),
      });
      instances.set(instance.id, instance);
      return instance;
    },
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.maxOpen === undefined ? {} : { maxOpen: options.maxOpen }),
    ...(options.maxPractice === undefined ? {} : { maxPractice: options.maxPractice }),
    ...(options.unloadMs === undefined ? {} : { unloadMs: options.unloadMs }),
    ...(options.practiceUnloadMs === undefined ? {} : { practiceUnloadMs: options.practiceUnloadMs }),
    ...(options.sweepMs === undefined ? {} : { sweepMs: options.sweepMs }),
    log: () => undefined,
    onOpened: (meeting) => opened.push(meeting.meetingId),
    onClosed: (id) => closed.push(id),
  });
  return { registry, store, instances, builtIds, closed, opened };
}

const registries: Built[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const built of registries.splice(0)) await built.registry.close();
});

describe('registry practice instances', () => {
  it('creates a fresh, memory-only practice with its own id', async () => {
    const built = build();
    registries.push(built);
    const first = await built.registry.createPractice();
    const second = await built.registry.createPractice();
    expect(first.runnerKind).toBe('practice');
    expect(second.runnerKind).toBe('practice');
    expect(first.id).not.toBe(second.id);
    expect(built.builtIds).toHaveLength(2);
    expect(built.store.rows.size).toBe(1); // only the real row the test seeded
    expect(built.opened).toEqual([first.id, second.id]);
    expect(await built.registry.get(first.id)).toBe(first);
    expect(built.registry.findPractice(first.id)).toBe(first);
  });

  it('gives a signed-in visitor a row in the sample workspace owned by them', async () => {
    const built = build();
    registries.push(built);
    await built.registry.createPractice({ ownerUserId: 'user-1', title: 'Practice · Opening day' });

    const id = built.builtIds[0]!;
    expect(built.store.rows.get(id)).toMatchObject({
      id,
      workspaceId: 'sample-nanyang-kopi',
      ownerUserId: 'user-1',
      title: 'Practice · Opening day',
      status: 'open',
    });
  });

  it('creates no open row when a signed-in practice cannot be built', async () => {
    const built = build({ failPracticeBuild: true });
    registries.push(built);

    await expect(built.registry.createPractice({ ownerUserId: 'user-1' })).rejects.toThrow(
      'build failed',
    );

    const practiceRows = [...built.store.rows.values()].filter(
      (meeting) => meeting.workspaceId === 'sample-nanyang-kopi',
    );
    expect(practiceRows).toEqual([]);
  });

  it('marks a signed-in practice row ended when it unloads', async () => {
    vi.useFakeTimers();
    let now = 1_000;
    const built = build({ now: () => now, practiceUnloadMs: 5_000, sweepMs: 1_000 });
    registries.push(built);
    const practice = await built.registry.createPractice({ ownerUserId: 'user-1' });
    expect(built.store.rows.get(practice.id)?.status).toBe('open');

    now += 6_000;
    await vi.advanceTimersByTimeAsync(1_000);

    expect(built.store.rows.get(practice.id)?.status).toBe('ended');
  });

  it('never reports a real meeting as a practice one', async () => {
    const built = build();
    registries.push(built);
    const real = await built.registry.get('real-1');
    expect(real).toBeDefined();
    expect(built.registry.findPractice('real-1')).toBeUndefined();
    expect(built.registry.findPractice('missing')).toBeUndefined();
  });

  it('counts practice toward the open cap', async () => {
    const built = build({ maxOpen: 2, maxPractice: 5 });
    registries.push(built);
    await built.registry.createPractice();
    await expect(built.registry.createPractice()).rejects.toBeInstanceOf(MeetingBusyError);
  });

  it('keeps room for a real meeting under the practice sub-cap', async () => {
    const built = build({ maxOpen: 4, maxPractice: 2 });
    registries.push(built);
    await built.registry.createPractice();
    await built.registry.createPractice();
    // A third practice is refused by its own sub-cap, not by the wider open cap.
    await expect(built.registry.createPractice()).rejects.toBeInstanceOf(PracticeFullError);
    // The practice traffic never took the room a real meeting needs.
    expect(await built.registry.get('real-1')).toBeDefined();
  });

  it('refuses a practice while the open cap is full even under the practice sub-cap', async () => {
    const built = build({ maxOpen: 3, maxPractice: 5 });
    registries.push(built);
    await built.registry.createPractice();
    await built.registry.get('real-1');
    // loaded: one practice + one real, plus the always-open legacy instance = 3.
    await expect(built.registry.createPractice()).rejects.toBeInstanceOf(MeetingBusyError);
  });

  it('unloads an empty practice after its own idle time and fires onClosed', async () => {
    vi.useFakeTimers();
    let now = 1_000;
    const built = build({
      now: () => now,
      practiceUnloadMs: 5_000,
      sweepMs: 1_000,
    });
    registries.push(built);
    const practice = await built.registry.createPractice();

    now += 4_000;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(built.closed).toEqual([]);
    expect(await built.registry.get(practice.id)).toBe(practice);

    now += 2_000;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(built.closed).toEqual([practice.id]);
    expect((built.instances.get(practice.id) as unknown as { disposed(): boolean }).disposed()).toBe(true);
    expect(built.registry.findPractice(practice.id)).toBeUndefined();
  });

  it('unloads an ended practice at once once it is empty', async () => {
    vi.useFakeTimers();
    const built = build({ now: () => 1_000, practiceUnloadMs: 300_000, sweepMs: 1_000 });
    registries.push(built);
    const practice = await built.registry.createPractice();
    // The meeting ends in place; the registry holds this same instance.
    (practice.session as unknown as { phase: () => string }).phase = () => 'ended';

    await vi.advanceTimersByTimeAsync(1_000);
    expect(built.closed).toEqual([practice.id]);
  });

  it('unloads an ended real meeting at once once it is empty', async () => {
    vi.useFakeTimers();
    const built = build({ now: () => 1_000, unloadMs: 1_800_000, sweepMs: 1_000 });
    registries.push(built);
    const real = await built.registry.get('real-1');
    if (real === undefined) throw new Error('the real meeting did not load');
    // The meeting ends in place; the registry holds this same instance for its room.
    (real.session as unknown as { phase: () => string }).phase = () => 'ended';
    built.registry.noteEnded('real-1');

    await vi.advanceTimersByTimeAsync(1_000);
    expect(built.closed).toEqual(['real-1']);
  });

  it('does not count an ended meeting toward the open or practice caps', async () => {
    const built = build({ maxOpen: 2, maxPractice: 1 });
    registries.push(built);
    const practice = await built.registry.createPractice();
    (practice.session as unknown as { phase: () => string }).phase = () => 'ended';

    // The ended practice freed both its practice room and its server-wide slot.
    const next = await built.registry.createPractice();
    expect(next).not.toBe(practice);
    expect(built.registry.findPractice(practice.id)).toBe(practice);
  });

  it('keeps a practice with someone in the room loaded', async () => {
    vi.useFakeTimers();
    const built = build({ now: () => 1_000, practiceUnloadMs: 1_000, sweepMs: 1_000 });
    registries.push(built);
    const practice = await built.registry.createPractice();
    (practice as unknown as { connectedPeople: () => number }).connectedPeople = () => 1;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(built.closed).toEqual([]);
  });
});
