import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KakiCommand, KakiEvent, Task } from '@kaki/shared';
import { createMattermostModule, type MattermostSettings } from '../../src/action/mattermost';
import { createMeetingModule } from '../../src/host/meeting';
import { createFakeLlm } from '../../src/llm';
import { connectClient, createTestApp, portOf, settle, waitForEvent, type TestClient } from '../helpers';

const settings: MattermostSettings = {
  url: 'http://mattermost.test',
  token: 'secret-token',
  team: 'kopitiam',
  channel: 'launch',
};

const decision =
  'Announce in the team channel today that we decided to move the cash box away from the food prep area and to count the till float every night.';
const decisionLine =
  'We decided to move the cash box away from the food prep area and to count the till float every night.';
const assignment = 'Ada, can you post that decision in the team channel today so everyone has it?';
const draftMessage =
  'We are moving the cash box away from the food prep area and counting the till float every night. Ada will announce it in the team channel.';

const reply = (body: Record<string, unknown>) =>
  JSON.stringify({ newQuestions: [], answeredQuestionIds: [], newTasks: [], ...body });

function send(client: TestClient, command: KakiCommand): void {
  client.ws.send(JSON.stringify(command));
}

function taskOf(event: KakiEvent): Task {
  if (event.type !== 'TASK_UPDATED') throw new Error(`Expected TASK_UPDATED, got ${event.type}`);
  return event.payload.task;
}

const clients: TestClient[] = [];
let app: Awaited<ReturnType<typeof createTestApp>> | undefined;

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await app?.close();
  app = undefined;
  vi.restoreAllMocks();
});

async function connect(role?: string): Promise<TestClient> {
  const client = await connectClient(portOf(app!), role);
  clients.push(client);
  return client;
}

describe('meeting to task to draft', () => {
  it('drafts a grounded Mattermost post from a meeting commitment without posting it', async () => {
    const notetakerLlm = createFakeLlm((messages) => {
      const text = messages.map((message) => message.content).join('\n');
      // Only the second batch contains the assignment; the task can be grounded only if the decision from the first
      // batch still travels with the prompt.
      if (!text.includes('Earlier lines on this agenda item')) return reply({});
      if (!text.includes(decisionLine)) return reply({});
      if (!text.includes('post that decision in the team channel')) return reply({});
      return reply({
        newTasks: [
          {
            title: 'Post the cash box decision in the team channel',
            context: decision,
            suggestedAssignee: 'chef',
            actionKind: 'mattermost_post',
            evidence: assignment,
            decisionEvidence: decisionLine,
          },
        ],
      });
    });
    const draftLlm = createFakeLlm(() => JSON.stringify({ message: draftMessage }));
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error('unexpected Mattermost request');
    });

    app = await createTestApp({
      modules: [
        createMeetingModule({
          llm: notetakerLlm,
          notetakerIntervalMs: 25,
          speed: 100,
          replay: [
            { at: 0, speaker: 'Ada (Chef)', text: decisionLine },
            { at: 100, speaker: 'Bao (Cashier)', text: assignment },
          ],
        }),
        createMattermostModule({ llm: draftLlm, mattermost: settings, fetchImpl }),
      ],
    });
    const screen = await connect('screen');
    const chef = await connect('chef');

    const suggested = await waitForEvent(
      screen,
      (event) =>
        event.type === 'TASK_UPDATED' &&
        event.payload.task.status === 'DISPATCHED' &&
        event.payload.task.title === 'Post the cash box decision in the team channel',
      'the notetaker task, dispatched to the chef',
    );
    const task = taskOf(suggested);
    expect(task).toMatchObject({
      title: 'Post the cash box decision in the team channel',
      context: decision,
      decisionSource: decisionLine,
      suggestedAssignee: 'chef',
      assignee: 'chef',
      actionKind: 'mattermost_post',
      status: 'DISPATCHED',
    });
    await waitForEvent(
      chef,
      (event) => event.type === 'TASK_UPDATED' && event.payload.task.id === task.id && event.payload.task.status === 'DISPATCHED',
      'the task on the chef\'s phone',
    );

    send(chef, { type: 'CLAIM_TASK', taskId: task.id, mode: 'ACTION_AGENT' });
    const ready = await waitForEvent(
      chef,
      (event) =>
        event.type === 'TASK_UPDATED' &&
        event.payload.task.id === task.id &&
        event.payload.task.status === 'DRAFT_READY',
      'the Mattermost draft',
      5_000,
    );

    expect(taskOf(ready).draft).toEqual({
      target: '#launch',
      subject: 'Post the cash box decision in the team channel',
      body: draftMessage,
    });
    const draftPrompt = draftLlm.calls[0]?.map((message) => message.content).join('\n') ?? '';
    expect(draftPrompt).toContain(decision);
    expect(draftPrompt).toContain('Accepted decision (verbatim from the meeting transcript');
    expect(draftPrompt).toContain(decisionLine);
    expect(draftPrompt).toContain('Post the cash box decision in the team channel');
    expect(fetchImpl).not.toHaveBeenCalled();
    await settle();
    expect(app.tasks.get(task.id)?.status).toBe('DRAFT_READY');
  });

  it('keeps one announcement when two different owners are asked to announce the same decision', async () => {
    const cashierAssignment = 'Bao, can you also announce the cash box move in the team channel today?';
    const notetakerLlm = createFakeLlm((messages) => {
      const text = messages.map((message) => message.content).join('\n');
      if (!text.includes('Earlier lines on this agenda item')) return reply({});
      if (!text.includes(decisionLine)) return reply({});
      if (!text.includes(assignment) || !text.includes(cashierAssignment)) return reply({});
      return reply({
        newTasks: [
          {
            title: 'Post the cash box decision in the team channel',
            context: decision,
            suggestedAssignee: 'chef',
            actionKind: 'mattermost_post',
            evidence: assignment,
            decisionEvidence: decisionLine,
          },
          {
            title: 'Announce the cash box move in the team channel',
            context: decision,
            suggestedAssignee: 'cashier',
            actionKind: 'mattermost_post',
            evidence: cashierAssignment,
            decisionEvidence: decisionLine,
          },
        ],
      });
    });
    const draftLlm = createFakeLlm(() => JSON.stringify({ message: draftMessage }));
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error('unexpected Mattermost request');
    });

    app = await createTestApp({
      modules: [
        createMeetingModule({
          llm: notetakerLlm,
          notetakerIntervalMs: 25,
          speed: 100,
          replay: [
            { at: 0, speaker: 'Ada (Chef)', text: decisionLine },
            { at: 100, speaker: 'Bao (Cashier)', text: assignment },
            { at: 150, speaker: 'Bao (Cashier)', text: cashierAssignment },
          ],
        }),
        createMattermostModule({ llm: draftLlm, mattermost: settings, fetchImpl }),
      ],
    });
    const screen = await connect('screen');
    await connect('chef');
    await connect('cashier');

    await waitForEvent(
      screen,
      (event) =>
        event.type === 'TASK_UPDATED' &&
        event.payload.task.status === 'DISPATCHED' &&
        event.payload.task.title === 'Post the cash box decision in the team channel',
      'the single dispatched announcement',
    );
    await settle();
    expect(app.tasks.list()).toHaveLength(1);
    expect(app.tasks.list()[0]?.decisionSource).toBe(decisionLine);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
