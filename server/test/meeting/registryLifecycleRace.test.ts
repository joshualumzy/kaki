import { describe, expect, it } from 'vitest';
import type { MeetingInstance } from '../../src/meeting/instance';
import {
  createMeetingRegistry,
  createMemoryMeetingStore,
  type MeetingRegistry,
} from '../../src/meeting/registry';
import type { MeetingPhase } from '../../src/meeting/session';

interface FakeInstance extends MeetingInstance {
  session: MeetingInstance['session'] & { phaseValue: MeetingPhase };
}

/** A minimal instance whose phase the fake end command can change. */
function fakeInstance(id: string, phase: MeetingPhase): FakeInstance {
  const instance = {
    id,
    workspaceId: 'workspace-1',
    ownerUserId: 'owner-1',
    runnerKind: 'real' as const,
    perVisitorPractice: false,
    roomName: `kaki-${id}`,
    session: {
      phaseValue: phase,
      phase() {
        return this.phaseValue;
      },
      abandoned: () => false,
    },
    hub: {
      async handleServerCommand(command: { type: string }) {
        if (command.type === 'END_MEETING') instance.session.phaseValue = 'ended';
      },
    },
    dispose: async () => undefined,
    handle: async () => undefined,
    handleUpgrade: () => undefined,
    lastActivityAt: () => 0,
    connectedPeople: () => 0,
    meetingCode: () => '',
    rebaseScheduledPlan: () => undefined,
  };
  return instance as unknown as FakeInstance;
}

function buildRegistry(
  buildInstance: (id: string) => Promise<MeetingInstance>,
): { registry: MeetingRegistry; store: ReturnType<typeof createMemoryMeetingStore> } {
  const store = createMemoryMeetingStore();
  const registry = createMeetingRegistry({
    store,
    buildInstance: async (row) => buildInstance(row.id),
    buildPracticeInstance: async () => {
      throw new Error('not used');
    },
    now: () => Date.now(),
    log: () => undefined,
  });
  return { registry, store };
}

/** Let the queued load reach its build before the lifecycle mutation is asked for. */
const nextTurn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('loads and lifecycle mutations are serialized per meeting', () => {
  it('cancels cleanly while a load is in flight, leaving no orphan instance', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const built: FakeInstance[] = [];
    const { registry, store } = buildRegistry(async (id) => {
      await gate;
      const instance = fakeInstance(id, 'lobby');
      built.push(instance);
      return instance;
    });
    const row = await store.create({
      workspaceId: 'workspace-1',
      ownerUserId: 'owner-1',
      title: 'Planning',
      status: 'scheduled',
      scheduledFor: new Date(Date.now() + 60 * 60_000).toISOString(),
    });

    const loading = registry.get(row.id);
    await nextTurn();
    const cancelling = registry.cancel(row.id);
    release();
    await loading;
    await cancelling;

    expect(built).toHaveLength(1);
    expect(await store.get(row.id)).toBeUndefined();
    expect(registry.openMeetings()).toEqual([]);
  });

  it('ends a room that was still loading instead of reporting it ended while it stays open', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let instance: FakeInstance | undefined;
    const { registry, store } = buildRegistry(async (id) => {
      await gate;
      instance = fakeInstance(id, 'running');
      return instance;
    });
    const row = await store.create({
      workspaceId: 'workspace-1',
      ownerUserId: 'owner-1',
      title: 'Planning',
      status: 'open',
    });

    const loading = registry.get(row.id);
    await nextTurn();
    const ending = registry.endMeeting(row.id);
    release();
    await loading;
    const outcome = await ending;

    expect(outcome).toBe('ended');
    expect(instance?.session.phase()).toBe('ended');
    expect((await store.get(row.id))?.status).toBe('ended');
  });
});
