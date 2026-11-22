import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KakiEvent, Task } from '@kaki/shared';
import { createWikiModule, type WikiSettings } from '../../src/action/wiki';
import { createMattermostModule } from '../../src/action/mattermost';
import { createEmailModule, type SendMail } from '../../src/action/email';
import { roleAudience } from '../../src/core/audience';
import type { Hub } from '../../src/core/hub';
import type { KakiContext } from '../../src/core/modules';
import { createFakeLlm } from '../../src/services/llm';
import { createTaskStore, type TaskStore } from '../../src/meeting/tasks';
import type { SavedMeetingDetails } from '../../src/persist/state';
import type { WorkspaceTools } from '../../src/workspace/tools';
import { testScenario } from '../fixtures/scenario';
import { waitFor } from '../helpers';

const settings: WikiSettings = { url: 'http://wiki.test', email: 'a@b.test', password: 'pw' };
const stops: Array<() => void> = [];

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  vi.restoreAllMocks();
});

function quietHub(): Hub {
  const listeners = new Set<(event: KakiEvent) => void>();
  return {
    publish: (event: KakiEvent) => {
      for (const listener of listeners) listener(event);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onCommand: () => {},
    clearRetained: () => {},
    close: () => {},
  };
}

interface SetupOptions {
  tools?: WorkspaceTools;
  meetingKind?: 'real' | 'practice';
  emailSent?: SendMail;
  fetchImpl?: typeof fetch;
}

function setup(options: SetupOptions = {}) {
  const hub = quietHub();
  const tasks = createTaskStore({ hub, scenario: testScenario });
  const archives: Array<{ minutes: string; todos: Array<{ id: string; title: string; owner: string; status: string }> }> = [];
  const tools: WorkspaceTools = options.tools ?? { readOnly: false };
  const llm = createFakeLlm(() => '{}');
  const context: KakiContext = {
    hub,
    tasks,
    activeScenario: () => testScenario,
    meetingId: () => 'meeting-1',
    workspaceId: () => 'workspace-1',
    tools: async () => tools,
    meetingKind: () => options.meetingKind ?? 'real',
    meetingDetails: () =>
      ({
        holders: [
          { name: 'ada', seat: 'chef', displayName: 'Ada', email: 'ada@example.com' },
          { name: 'bao', seat: 'cashier', displayName: 'Bao', email: 'bao@example.com' },
        ],
        offTheRecordSpans: [],
      }) as unknown as SavedMeetingDetails,
    archiveMinutes: async (input) => {
      archives.push(input);
    },
  };
  const stop = createWikiModule({
    llm,
    wiki: settings,
    minutesDelayMs: 10,
    today: () => '2026-11-03',
    fetchImpl: vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 })),
  }).start(context);
  if (stop !== undefined) stops.push(stop);
  if (options.fetchImpl !== undefined) {
    const stopMattermost = createMattermostModule({ llm, fetchImpl: options.fetchImpl }).start(context);
    if (stopMattermost !== undefined) stops.push(stopMattermost);
  }
  if (options.emailSent !== undefined) {
    const stopEmail = createEmailModule({ llm, sendMail: options.emailSent }).start(context);
    if (stopEmail !== undefined) stops.push(stopEmail);
  }
  return { tasks, archives, hub };
}

function closeMeeting(hub: Hub): void {
  hub.publish({
    type: 'TRANSCRIPT_CHUNK',
    audience: { kind: 'all' },
    payload: { speaker: 'Ada (Chef)', text: 'We agreed the rota change.', timestamp: '2026-11-03T10:00:00Z' },
  });
  hub.publish({
    type: 'HOST_SPEECH_TRIGGERED',
    audience: { kind: 'screen' },
    payload: { kind: 'CLOSING', text: 'That concludes our meeting.' },
  });
}

function notesTasks(tasks: TaskStore): Task[] {
  return tasks.list().filter((task) => task.purpose === 'meeting_notes');
}

function waitForNotes(tasks: TaskStore, count = 2): Promise<Task[]> {
  return waitFor(
    () => {
      const found = notesTasks(tasks);
      return found.length === count && found.every((task) => task.status === 'DRAFT_READY') ? found : undefined;
    },
    `the ${count} send-the-notes cards`,
  );
}

describe('send the notes at End', () => {
  it('keeps Kaki’s own copy and offers a card for chat and email without sending anything yet', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('/channels/name/general')) {
        return new Response(JSON.stringify({ id: 'channel-1' }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: 'post-1', message: 'posted' }), { status: 201 });
    });
    const sent: unknown[] = [];
    const sendMail: SendMail = async (message) => {
      sent.push(message);
      return { messageId: message.messageId };
    };
    const { tasks, archives, hub } = setup({
      tools: {
        mattermost: { url: 'http://mm.test', token: 't', team: 'team', channel: 'general' },
        email: { smtpHost: 'smtp.test', smtpPort: 1025, from: 'kaki@test', mailpitUrl: 'http://mail.test' },
        readOnly: false,
      },
      fetchImpl,
      emailSent: sendMail,
    });
    tasks.suggest({ title: 'Update the rota', context: 'After the meeting.', suggestedAssignee: 'cashier' });
    closeMeeting(hub);

    const notes = await waitForNotes(tasks);
    expect(notes.map((task) => task.actionKind).sort()).toEqual(['email', 'mattermost_post']);
    expect(notes.every((task) => task.draft?.body.includes('Meeting Minutes'))).toBe(true);
    expect(notes.find((task) => task.actionKind === 'mattermost_post')?.draft?.target).toBe('#general');
    expect(notes.find((task) => task.actionKind === 'email')?.draft?.target).toBe('ada@example.com, bao@example.com');
    // Nothing has gone out: both are waiting for the owner's approval.
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);

    // Kaki's own copy is kept as soon as the minutes exist.
    await waitFor(() => (archives.length === 1 ? archives[0] : undefined), "Kaki's minutes copy");
    expect(archives[0]?.minutes).toContain('Meeting Minutes');
    expect(archives[0]?.todos).toEqual([
      { id: expect.any(String), title: 'Update the rota', owner: 'Cashier', status: 'SUGGESTED' },
    ]);
  });

  it('sends only after the owner approves, with the one Action footer', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/channels/name/general')) {
        return new Response(JSON.stringify({ id: 'channel-1' }), { status: 200 });
      }
      calls.push({ url, body: String(init?.body ?? '') });
      return new Response(JSON.stringify({ id: 'post-1', message: 'posted' }), { status: 201 });
    });
    const { tasks, hub } = setup({
      tools: {
        mattermost: { url: 'http://mm.test', token: 't', team: 'team', channel: 'general' },
        readOnly: false,
      },
      fetchImpl,
    });
    closeMeeting(hub);
    const [card] = await waitForNotes(tasks, 1);

    tasks.handleCommand(
      { type: 'APPROVE_ACTION', taskId: card!.id, draft: card!.draft! },
      roleAudience('chef'),
    );

    const done = await waitFor(
      () => {
        const task = tasks.get(card!.id);
        return task?.status === 'COMPLETED' ? task : undefined;
      },
      'the notes post to finish',
    );
    expect(done.artifactUrl).toBe('http://mm.test/team/pl/post-1');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toContain('Posted by Kaki for Ada, approved in Lunch service readiness.');
  });

  it('offers no send card when the workspace has no tool connected', async () => {
    const { tasks, archives, hub } = setup({ tools: { readOnly: false } });
    closeMeeting(hub);

    await waitFor(() => (archives.length === 1 ? true : undefined), "Kaki's minutes copy");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(notesTasks(tasks)).toHaveLength(0);
  });

  it('does not add send cards to a practice meeting', async () => {
    const { tasks, hub } = setup({
      tools: {
        mattermost: { url: 'http://mm.test', token: 't', team: 'team', channel: 'general' },
        readOnly: true,
      },
      meetingKind: 'practice',
    });
    closeMeeting(hub);

    await waitFor(
      () => tasks.list().find((task) => task.purpose === 'meeting_minutes'),
      'the practice minutes card',
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(notesTasks(tasks)).toHaveLength(0);
  });
});
