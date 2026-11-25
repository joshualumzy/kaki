import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type KakiApp } from '../../src/app';
import { createAuth } from '../../src/auth/module';
import { hashToken } from '../../src/auth/password';
import { createMemoryAuthStore, type AuthStore, type UserRecord } from '../../src/auth/store';
import type { KakiModule } from '../../src/core/modules';
import { createMemoryMeetingStore } from '../../src/meeting/registry';
import { createMemoryWorkspaceToolStore, type WorkspaceToolStore } from '../../src/workspace/tools';
import { testScenario } from '../fixtures/scenario';
import { portOf, realModulesWith } from '../helpers';

const apps: KakiApp[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

/** Stands in for the wiki action: approves the minutes card into a published page. */
const minutesPublisher: KakiModule = {
  name: 'test-minutes-publisher',
  start(ctx) {
    return ctx.tasks.onChange((task) => {
      if (task.purpose !== 'meeting_minutes' || task.status !== 'RUNNING') return;
      setTimeout(() => {
        try {
          ctx.tasks.transition(task.id, 'COMPLETED', {
            artifactUrl: 'https://wiki.example/en/meetings/2026-11-20-weekly-planning',
          });
        } catch {
          // The task already moved on; nothing to publish.
        }
      }, 0);
    });
  },
};

interface SignedIn {
  user: UserRecord;
  cookie: string;
}

async function signIn(store: AuthStore, name: string): Promise<SignedIn> {
  const email = `${randomUUID()}@example.com`;
  const user = await store.createGoogleUser({ googleSub: randomUUID(), name, email });
  const token = randomUUID();
  await store.createSession({
    tokenHash: hashToken(token),
    kind: 'user',
    role: null,
    meetingCode: null,
    meetingId: null,
    displayName: name,
    userId: user.id,
    expiresAt: new Date(Date.now() + 60_000),
  });
  return { user, cookie: `kaki_session=${token}` };
}

async function buildApp(): Promise<{
  base: string;
  store: AuthStore;
  meetings: ReturnType<typeof createMemoryMeetingStore>;
  workspaceTools: WorkspaceToolStore;
  app: KakiApp;
}> {
  const store = createMemoryAuthStore();
  const auth = createAuth({ store });
  const meetings = createMemoryMeetingStore();
  const workspaceTools = createMemoryWorkspaceToolStore();
  const app = await createApp({
    scenario: testScenario,
    speechRecognition: 'browser',
    auth,
    meetings,
    workspaceTools,
    meetingModules: realModulesWith([minutesPublisher]),
  });
  apps.push(app);
  return { base: `http://127.0.0.1:${portOf(app)}`, store, meetings, workspaceTools, app };
}

function request(
  base: string,
  path: string,
  options: { method?: string; cookie?: string; body?: unknown } = {},
): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

async function connectWiki(
  workspaceTools: WorkspaceToolStore,
  workspaceId: string,
  connectedBy: string,
): Promise<void> {
  await workspaceTools.save({
    workspaceId,
    kind: 'wiki',
    settings: { url: 'https://wiki.example' },
    secret: Buffer.from('secret'),
    iv: Buffer.alloc(16),
    tag: Buffer.alloc(16),
    keyId: 'test',
    connectedBy,
    connectedAt: new Date(),
    lastOkAt: null,
  });
}

async function endedMeetingWithMinutes(options: {
  meetings: ReturnType<typeof createMemoryMeetingStore>;
  app: KakiApp;
  owner: SignedIn;
  workspaceId: string;
}): Promise<{ meetingId: string; taskId: string }> {
  const meeting = await options.meetings.create({
    workspaceId: options.workspaceId,
    ownerUserId: options.owner.user.id,
    title: 'Weekly planning',
  });
  await options.meetings.markEnded?.(meeting.id, '2026-11-20T10:00:00.000Z');
  await options.meetings.saveMinutes?.(meeting.id, {
    minutes: '# Weekly planning\n\nWe agreed the rota.',
    todos: [],
  });
  const instance = await options.app.registry.get(meeting.id);
  if (instance === undefined) throw new Error('the ended meeting did not load');
  const task = instance.tasks.suggestWithPurpose(
    {
      title: 'Publish meeting minutes to the team wiki',
      context: 'Full summary of Weekly planning.',
      suggestedAssignee: 'everyone',
      actionKind: 'wiki_page',
    },
    'meeting_minutes',
  );
  instance.tasks.transition(task.id, 'DISPATCHED', { assignee: 'everyone' });
  instance.tasks.transition(task.id, 'CLAIMED', {
    mode: 'ACTION_AGENT',
    draft: {
      target: 'Wiki: meeting notes',
      subject: 'Weekly planning — Meeting Minutes',
      body: '# Weekly planning\n\nWe agreed the rota.',
    },
  });
  instance.tasks.transition(task.id, 'DRAFT_READY');
  return { meetingId: meeting.id, taskId: task.id };
}

async function minutesJson(base: string, path: string, cookie: string): Promise<Record<string, unknown>> {
  const response = await request(base, path, { cookie });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

async function waitForPublished(
  base: string,
  path: string,
  cookie: string,
): Promise<Record<string, unknown>> {
  let last: Record<string, unknown> = {};
  for (let attempt = 0; attempt < 100; attempt += 1) {
    last = await minutesJson(base, path, cookie);
    const publish = last.publish;
    if (typeof publish === 'object' && publish !== null && (publish as { status?: string }).status === 'published') {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return last;
}

describe('meeting minutes publish API', () => {
  it('lets the owner publish from history through the minutes card and keeps the result', async () => {
    const { base, store, meetings, workspaceTools, app } = await buildApp();
    const ada = await signIn(store, 'Ada');
    const workspace = await store.createWorkspace({ name: 'Kitchen', createdBy: ada.user.id });
    await connectWiki(workspaceTools, workspace.workspace.id, ada.user.id);
    const { meetingId, taskId } = await endedMeetingWithMinutes({
      meetings,
      app,
      owner: ada,
      workspaceId: workspace.workspace.id,
    });
    const path = `/api/workspaces/${workspace.workspace.id}/meetings/${meetingId}/minutes`;

    const before = await minutesJson(base, path, ada.cookie);
    expect(before).toMatchObject({
      canEdit: true,
      wikiConnected: true,
      publish: { status: 'draft' },
    });

    const response = await request(base, `${path}/publish`, { method: 'POST', cookie: ada.cookie });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ publish: { status: 'publishing' } });

    const published = await waitForPublished(base, path, ada.cookie);
    expect(published.publish).toMatchObject({
      status: 'published',
      artifactUrl: 'https://wiki.example/en/meetings/2026-11-20-weekly-planning',
    });
    const instance = await app.registry.get(meetingId);
    expect(instance?.tasks.get(taskId)?.status).toBe('COMPLETED');
  });

  it('refuses a member who is neither the owner nor an admin', async () => {
    const { base, store, meetings, workspaceTools } = await buildApp();
    const ada = await signIn(store, 'Ada');
    const ben = await signIn(store, 'Ben');
    const workspace = await store.createWorkspace({ name: 'Kitchen', createdBy: ada.user.id });
    await store.addWorkspaceMember({
      workspaceId: workspace.workspace.id,
      userId: ben.user.id,
      role: 'member',
    });
    await connectWiki(workspaceTools, workspace.workspace.id, ada.user.id);
    const meeting = await meetings.create({
      workspaceId: workspace.workspace.id,
      ownerUserId: ada.user.id,
      title: 'Weekly planning',
    });
    await meetings.markEnded?.(meeting.id, '2026-11-20T10:00:00.000Z');
    await meetings.saveMinutes?.(meeting.id, { minutes: '# Minutes', todos: [] });

    const refused = await request(
      base,
      `/api/workspaces/${workspace.workspace.id}/meetings/${meeting.id}/minutes/publish`,
      { method: 'POST', cookie: ben.cookie },
    );
    expect(refused.status).toBe(403);
  });

  it('says plainly when no wiki is connected instead of pretending to publish', async () => {
    const { base, store, meetings, app } = await buildApp();
    const ada = await signIn(store, 'Ada');
    const workspace = await store.createWorkspace({ name: 'Kitchen', createdBy: ada.user.id });
    const { meetingId } = await endedMeetingWithMinutes({
      meetings,
      app,
      owner: ada,
      workspaceId: workspace.workspace.id,
    });

    const response = await request(
      base,
      `/api/workspaces/${workspace.workspace.id}/meetings/${meetingId}/minutes/publish`,
      { method: 'POST', cookie: ada.cookie },
    );
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toMatch(/No wiki is connected/);
  });
});
