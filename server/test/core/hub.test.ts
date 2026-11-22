import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KakiEvent } from '@kaki/shared';
import {
  connectClient,
  createTestApp,
  portOf,
  settle,
  taskStatuses,
  waitForEvent,
  type TestClient,
} from '../helpers';

const note: KakiEvent = {
  type: 'WINGMAN_NOTE',
  audience: { kind: 'role', role: 'chef' },
  payload: {
    id: 'answer:chef',
    kind: 'answer',
    urgency: 'quiet',
    title: 'Wingman',
    text: 'Prep starts in one minute.',
  },
};

const opening: KakiEvent = {
  type: 'HOST_SPEECH_TRIGGERED',
  audience: { kind: 'screen' },
  payload: { kind: 'OPENING', text: 'Welcome to lunch service.' },
};

const recordUpdate: KakiEvent = {
  type: 'MEETING_RECORD_UPDATED',
  audience: { kind: 'all' },
  payload: {
    agendaIndex: 0,
    openQuestions: [{ id: 'q-oven', text: 'When was the oven last serviced?', forRole: 'chef', agendaIndex: 0 }],
    elapsedSeconds: 125,
    speakerTalkSeconds: { chef: 90, cashier: 35 },
  },
};

function isTaskUpdate(event: KakiEvent, taskId: string, status: string): boolean {
  return (
    event.type === 'TASK_UPDATED' &&
    event.payload.task.id === taskId &&
    event.payload.task.status === status
  );
}

describe('hub delivery', () => {
  let app: Awaited<ReturnType<typeof createTestApp>>;
  let port: number;
  let clients: TestClient[];

  beforeEach(async () => {
    app = await createTestApp();
    port = portOf(app);
    clients = [];
  });

  afterEach(async () => {
    for (const client of clients) client.close();
    await app.close();
  });

  async function connect(role: string): Promise<TestClient> {
    const client = await connectClient(port, role);
    clients.push(client);
    return client;
  }

  it('sends role, screen and all events to exactly their audience', async () => {
    const screen = await connect('screen');
    const chef = await connect('chef');
    const cashier = await connect('cashier');

    app.hub.publish(recordUpdate);
    app.hub.publish(note);
    app.hub.publish(opening);
    await settle();

    expect(screen.messages).toEqual([recordUpdate, opening]);
    expect(chef.messages).toEqual([recordUpdate, note]);
    expect(cashier.messages).toEqual([recordUpdate]);
  });

  it('throws when asked to publish an invalid event', () => {
    const invalid = { type: 'WINGMAN_NOTE', audience: { kind: 'role', role: 'waiter' }, payload: { id: 'note', kind: 'answer', urgency: 'quiet', title: 'Wingman', text: 'x' } };
    expect(() => app.hub.publish(invalid as unknown as KakiEvent)).toThrow(/invalid event/);
  });

  it('replays retained events to late joiners and skips unretained events', async () => {
    const screen = await connect('screen');
    const first = app.tasks.suggest({
      title: 'Fix the oven',
      context: 'It trips the fuse.',
      suggestedAssignee: 'chef',
    });
    const second = app.tasks.suggest({
      title: 'Count the float',
      context: 'The till float is short.',
      suggestedAssignee: 'cashier',
    });

    screen.ws.send(JSON.stringify({ type: 'DISPATCH_TASK', taskId: first.id, assignee: 'chef' }));
    await waitForEvent(screen, (event) => isTaskUpdate(event, first.id, 'DISPATCHED'), 'dispatch');
    app.hub.publish(recordUpdate, { retainKey: 'record' });

    const lateChef = await connect('chef');
    const lateScreen = await connect('screen');

    await waitForEvent(lateChef, (event) => isTaskUpdate(event, first.id, 'DISPATCHED'), 'chef task');
    await waitForEvent(lateScreen, (event) => isTaskUpdate(event, first.id, 'DISPATCHED'), 'screen task');
    await waitForEvent(lateScreen, (event) => isTaskUpdate(event, second.id, 'SUGGESTED'), 'second task');
    await waitForEvent(lateScreen, (event) => event.type === 'MEETING_RECORD_UPDATED', 'record');

    expect(taskStatuses(lateChef, first.id)).toEqual(['DISPATCHED']);
    expect(taskStatuses(lateChef, second.id)).toEqual([]);
    expect(taskStatuses(lateScreen, first.id)).toEqual(['DISPATCHED']);
    expect(taskStatuses(lateScreen, second.id)).toEqual(['SUGGESTED']);
  });

  it('notifies subscribers and survives a throwing subscriber', () => {
    const received: KakiEvent[] = [];
    const unsubscribe = app.hub.subscribe((event) => received.push(event));
    app.hub.subscribe(() => {
      throw new Error('subscriber boom');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      expect(() => app.hub.publish(note)).not.toThrow();
    } finally {
      errorSpy.mockRestore();
      unsubscribe();
    }

    expect(received).toEqual([note]);
  });
});
