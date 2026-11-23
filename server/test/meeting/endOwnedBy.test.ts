import { describe, expect, it } from 'vitest';
import type { KakiCommand } from '@kaki/shared';
import type { ClientAudience } from '../../src/core/audience';
import type { MeetingInstance } from '../../src/meeting/instance';
import { createMeetingRegistry, createMemoryMeetingStore } from '../../src/meeting/registry';

const OWNER = 'user-ada';

function fakeInstance(
  id: string,
  onEnd: (command: KakiCommand, sender: ClientAudience) => Promise<void> = async () => undefined,
): MeetingInstance {
  return {
    id,
    workspaceId: 'workspace-ada',
    runnerKind: 'real',
    perVisitorPractice: false,
    roomName: `kaki-${id}`,
    session: { phase: () => 'running' },
    hub: { handleServerCommand: onEnd },
    dispose: async () => undefined,
    handle: async () => undefined,
    handleUpgrade: () => undefined,
    lastActivityAt: () => 0,
    connectedPeople: () => 0,
    meetingCode: () => '',
  } as unknown as MeetingInstance;
}

const legacy = fakeInstance('meeting');

function buildRegistry(instance: (id: string) => MeetingInstance) {
  const store = createMemoryMeetingStore();
  const registry = createMeetingRegistry({
    legacy,
    store,
    buildInstance: async (row) => instance(row.id),
    buildPracticeInstance: async () => {
      throw new Error('not used');
    },
    now: () => Date.now(),
    log: () => undefined,
  });
  return { registry, store };
}

describe('endOwnedBy', () => {
  it('silent-ends a running owned meeting so its guests see a plain end', async () => {
    let seen: { command: KakiCommand; sender: ClientAudience } | undefined;
    const { registry, store } = buildRegistry((id) =>
      fakeInstance(id, async (command, sender) => {
        seen = { command, sender };
      }),
    );
    const row = await store.create({
      workspaceId: 'workspace-ada',
      ownerUserId: OWNER,
      title: 'Planning',
      status: 'open',
    });
    await registry.get(row.id);

    await registry.endOwnedBy(OWNER, []);

    expect(seen).toEqual({ command: { type: 'END_MEETING', silent: true }, sender: { kind: 'screen' } });
    expect((await store.get(row.id))?.status).toBe('ended');
    expect(registry.openMeetings().some((meeting) => meeting.meetingId === row.id)).toBe(false);
  });

  it('rejects when a meeting could not end, so the account is not deleted', async () => {
    const { registry, store } = buildRegistry((id) =>
      fakeInstance(id, async () => {
        throw new Error('the runner is gone');
      }),
    );
    const row = await store.create({
      workspaceId: 'workspace-ada',
      ownerUserId: OWNER,
      title: 'Planning',
      status: 'open',
    });
    await registry.get(row.id);

    await expect(registry.endOwnedBy(OWNER, [])).rejects.toThrow(row.id);
  });
});
