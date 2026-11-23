import { KAKI_LISTENER_IDENTITY } from '@kaki/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { KakiApp } from '../../src/app';
import { createAgendaClock } from '../../src/host/clock';
import { createMeetingModule } from '../../src/host/meeting';
import { loadScenario } from '../../src/core/loadScenario';
import {
  connectMeetingClient,
  createRealTestApp,
  meetingUrl,
  portOf,
  realModulesWith,
  settle,
  waitForEvent,
  type TestAppWithMeeting,
  type TestClient,
} from '../helpers';

const apps: KakiApp[] = [];
const sockets: WebSocket[] = [];
const clients: TestClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const app of apps.splice(0)) await app.close();
  vi.restoreAllMocks();
});

function resetCount(client: TestClient): number {
  return client.messages.filter((event) => event.type === 'MEETING_RESET').length;
}

interface RealStartedMeeting {
  app: TestAppWithMeeting;
  screen: TestClient;
  seat: string;
  meetingId: string;
  taskId: string;
}

function realJoin(app: TestAppWithMeeting, body: Record<string, unknown>): Promise<Response> {
  return fetch(meetingUrl(app, app.meetingId, '/api/livekit/token'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roomName: 'test-room', ...body }),
  });
}

async function realMeetingState(
  app: TestAppWithMeeting,
): Promise<{ meetingId: string; started: boolean }> {
  return (await (await fetch(meetingUrl(app, app.meetingId, '/api/meeting/state'))).json()) as {
    meetingId: string;
    started: boolean;
  };
}

async function realStartedMeeting(): Promise<RealStartedMeeting> {
  const scenario = await loadScenario('kopitiam');
  const app = await createRealTestApp(
    {
      speechRecognition: 'browser',
      scenario,
      roomRoster: async () => [],
      rejoinGraceMs: 60_000,
      rejoinPollMs: 60_000,
      admissionReservationMs: 20,
      devRoutes: true,
    },
    { title: 'Weekly planning' },
  );
  apps.push(app);
  const port = portOf(app);

  const first = await realJoin(app, { participantName: 'Booth Playtest', participantRole: 'operations_director' });
  expect(first.status).toBe(200);
  const seat = ((await first.json()) as { participantRole: string }).participantRole;
  const screen = await connectMeetingClient(port, app.meetingId, 'screen');
  clients.push(screen);

  expect((await fetch(meetingUrl(app, app.meetingId, '/api/meeting/start'), { method: 'POST' })).status).toBe(200);
  const task = app.tasks.suggest({
    title: 'Keep this card',
    context: 'From the running meeting',
    suggestedAssignee: seat,
  });
  await settle();
  const state = await realMeetingState(app);
  expect(state.started).toBe(true);

  screen.messages.length = 0;
  return { app, screen, seat, meetingId: state.meetingId, taskId: task.id };
}

describe('join admission never wipes a running meeting', () => {
  it('refuses the runner listener name for a person', async () => {
    const meeting = await realStartedMeeting();
    const code = meeting.app.instance.meetingCode();

    const refused = await realJoin(meeting.app, {
      participantName: KAKI_LISTENER_IDENTITY,
      participantRole: 'operations_director',
    });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toMatch(/AI attendee|reserved for the meeting listener/i);

    expect(await realMeetingState(meeting.app)).toMatchObject({
      meetingId: meeting.meetingId,
      started: true,
    });
    expect(meeting.app.instance.meetingCode()).toBe(code);
    expect(meeting.app.tasks.get(meeting.taskId)?.title).toBe('Keep this card');
    await settle();
    expect(resetCount(meeting.screen)).toBe(0);
  });

  it('refuses an over-long name without wiping the meeting', async () => {
    const meeting = await realStartedMeeting();
    const code = meeting.app.instance.meetingCode();

    const refused = await realJoin(meeting.app, {
      participantName: 'x'.repeat(61),
      participantRole: 'operations_director',
    });
    expect(refused.status).toBe(400);

    expect(await realMeetingState(meeting.app)).toMatchObject({
      meetingId: meeting.meetingId,
      started: true,
    });
    expect(meeting.app.instance.meetingCode()).toBe(code);
    expect(meeting.app.tasks.get(meeting.taskId)?.title).toBe('Keep this card');
    await settle();
    expect(resetCount(meeting.screen)).toBe(0);
  });
});

describe('foreign resets', () => {
  it('refuses a MEETING_RESET published outside the meeting session', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const meeting = await realStartedMeeting();
    const resetsBefore = resetCount(meeting.screen);
    let resetSubscriberRuns = 0;
    const unsubscribe = meeting.app.hub.subscribe((event) => {
      if (event.type === 'MEETING_RESET') resetSubscriberRuns += 1;
    });

    try {
      expect(() =>
        meeting.app.hub.publish({
          type: 'MEETING_RESET',
          audience: { kind: 'all' },
          payload: { meetingId: 'foreign-meeting' },
        }),
      ).toThrow(/MEETING_RESET/);
      await settle();

      expect(error).toHaveBeenCalledWith(expect.stringContaining('refused to publish a MEETING_RESET'));
      expect(resetSubscriberRuns).toBe(0);
      expect(resetCount(meeting.screen)).toBe(resetsBefore);
      expect(await realMeetingState(meeting.app)).toMatchObject({
        meetingId: meeting.meetingId,
        started: true,
      });
      expect(meeting.app.tasks.get(meeting.taskId)?.title).toBe('Keep this card');
    } finally {
      unsubscribe();
    }
  });

  it('refuses a MEETING_RESET sent through the event-injection routes', async () => {
    const meeting = await realStartedMeeting();
    const resetsBefore = resetCount(meeting.screen);

    const res = await fetch(meetingUrl(meeting.app, meeting.app.meetingId, '/dev/emit'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'MEETING_RESET',
        audience: { kind: 'all' },
        payload: { meetingId: 'foreign-meeting' },
      }),
    });
    await settle();

    expect(res.status).toBe(400);
    expect(resetCount(meeting.screen)).toBe(resetsBefore);
    expect(await realMeetingState(meeting.app)).toMatchObject({
      meetingId: meeting.meetingId,
      started: true,
    });
    expect(meeting.app.tasks.get(meeting.taskId)?.title).toBe('Keep this card');
  });
});

describe('New meeting', () => {
  it('resets once and resets the agenda clock once', async () => {
    const scenario = await loadScenario('kopitiam');
    const clock = createAgendaClock({ agenda: scenario.agenda });
    const reset = vi.spyOn(clock, 'reset');
    const app = await createRealTestApp(
      {
        speechRecognition: 'browser',
        scenario,
        roomRoster: async () => [],
        rejoinGraceMs: 60_000,
        rejoinPollMs: 60_000,
        meetingModules: realModulesWith([createMeetingModule({ clock, notetakerIntervalMs: 60_000 })]),
      },
      { title: 'Weekly planning', agenda: scenario.agenda },
    );
    apps.push(app);
    const port = portOf(app);

    expect(
      (await realJoin(app, { participantName: 'Booth Playtest', participantRole: 'operations_director' })).status,
    ).toBe(200);
    expect((await fetch(meetingUrl(app, app.meetingId, '/api/meeting/start'), { method: 'POST' })).status).toBe(200);
    const screen = await connectMeetingClient(port, app.meetingId, 'screen');
    clients.push(screen);
    screen.messages.length = 0;
    reset.mockClear();

    screen.ws.send(JSON.stringify({ type: 'NEW_MEETING' }));
    await waitForEvent(screen, (event) => event.type === 'MEETING_RESET', 'the New meeting reset');
    await settle();

    expect(screen.messages.filter((event) => event.type === 'MEETING_RESET')).toHaveLength(1);
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
