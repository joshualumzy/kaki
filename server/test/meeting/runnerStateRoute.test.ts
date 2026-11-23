import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { KakiEvent, RunnerMeetingSnapshot, RunnerSnapshotVersion } from '@kaki/shared';
import { createAgendaClock } from '../../src/host/clock';
import { createMeetingModule } from '../../src/host/meeting';
import { loadScenario } from '../../src/core/loadScenario';
import {
  connectMeetingClient,
  createPracticeTestApp,
  createRealTestApp,
  meetingUrl,
  meetingWsUrl,
  portOf,
  practiceModulesWith,
  settle,
  waitFor,
  type TestAppWithMeeting,
} from '../helpers';

const TOKEN = 'runner-secret';
let app: TestAppWithMeeting | undefined;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await app?.close();
  app = undefined;
});

async function runnerState(): Promise<RunnerMeetingSnapshot> {
  const response = await fetch(meetingUrl(app!, app!.meetingId, '/api/runner/meeting-state'), {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as RunnerMeetingSnapshot;
}

async function join(participantName: string, participantRole: string): Promise<Response> {
  return fetch(meetingUrl(app!, app!.meetingId, '/api/livekit/token'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: app!.cookie! },
    body: JSON.stringify({ participantName, participantRole, kind: 'practice' }),
  });
}

function startMeeting(): Promise<Response> {
  return fetch(meetingUrl(app!, app!.meetingId, '/api/meeting/start'), {
    method: 'POST',
    headers: { cookie: app!.cookie! },
  });
}

async function connectService(): Promise<{ ws: WebSocket; messages: KakiEvent[] }> {
  const ws = new WebSocket(meetingWsUrl(portOf(app!), app!.meetingId, 'role=service'), {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  sockets.push(ws);
  const messages: KakiEvent[] = [];
  ws.on('message', (data) => {
    const message = JSON.parse(data.toString()) as KakiEvent & {
      kind?: string;
      request?: { requestId?: string; attempt?: string; meetingId?: string };
    };
    messages.push(message);
    const { requestId, attempt, meetingId } = message.request ?? {};
    if (message.kind === 'prepare' && requestId !== undefined && attempt !== undefined && meetingId !== undefined) {
      ws.send(JSON.stringify({ kind: 'ready', requestId, attempt, meetingId }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return { ws, messages };
}

function runnerStates(messages: KakiEvent[]): RunnerMeetingSnapshot[] {
  return messages.flatMap((event) => (event.type === 'RUNNER_STATE' ? [event.payload] : []));
}

function expectNewerThan(after: RunnerSnapshotVersion, before: RunnerSnapshotVersion): void {
  expect(after.epoch).toEqual(before.epoch);
  expect(after.seq).toBeGreaterThan(before.seq);
}

describe('the service-only runner meeting endpoint', () => {
  it('refuses browsers without the service token and serves the snapshot with it', async () => {
    app = await createPracticeTestApp({
      speechRecognition: 'browser',
      scenario: await loadScenario('kopitiam'),
      serviceToken: TOKEN,
      roomRoster: async () => [],
    });

    const anonymous = await fetch(meetingUrl(app, app.meetingId, '/api/runner/meeting-state'));
    expect(anonymous.status).toBe(401);

    const state = await runnerState();
    expect(state.meetingId).toBeTruthy();
    expect(state.phase).toBe('lobby');
    expect(state.cast.length).toBeGreaterThan(0);

    // The browser-facing state keeps its small public shape; who joined is owner-only.
    const publicState = await fetch(meetingUrl(app, app.meetingId, '/api/meeting/state'));
    expect(Object.keys((await publicState.json()) as Record<string, unknown>).sort()).toEqual([
      'kind',
      'meetingId',
      'started',
    ]);
  });
});

describe('a reset always yields a newer snapshot', () => {
  it('bumps the version even when the meeting id stays the same', async () => {
    app = await createPracticeTestApp({
      speechRecognition: 'browser',
      scenario: await loadScenario('kopitiam'),
      serviceToken: TOKEN,
      roomRoster: async () => [],
    });
    const before = await runnerState();

    app.session.reset({ rotateIdentity: false });

    const after = await runnerState();
    expect(after.meetingId).toBe(before.meetingId);
    expectNewerThan(after.version, before.version);
  });
});

describe('server-owned host mode', () => {
  it('is still correct when a runner asks again after a restart', async () => {
    app = await createPracticeTestApp({
      speechRecognition: 'browser',
      scenario: await loadScenario('kopitiam'),
      serviceToken: TOKEN,
      roomRoster: async () => [],
    });
    app.session.addHolder({ name: 'Mia', seat: 'general_manager' });

    const first = await runnerState();
    const afterRestart = await runnerState();
    expect(first.hostSeat).toBe('general_manager');
    expect(first.hostIsHuman).toBe(true);
    expect(afterRestart.hostIsHuman).toBe(true);
    expect(afterRestart.version).toEqual(first.version);
  });
});

describe('RUNNER_STATE over the service channel', () => {
  it('reaches the runner on Start, agenda move, pause and reset', async () => {
    const scenario = await loadScenario('kopitiam');
    const clock = createAgendaClock({ agenda: scenario.agenda });
    app = await createPracticeTestApp({
      speechRecognition: 'browser',
      scenario,
      serviceToken: TOKEN,
      roomRoster: async () => [],
      rejoinGraceMs: 60_000,
      rejoinPollMs: 60_000,
      practiceModules: practiceModulesWith([createMeetingModule({ clock })], {
        meetingAgendaIndex: () => {
          const snapshot = clock.snapshot();
          return snapshot.started ? snapshot.agendaIndex : undefined;
        },
        meetingPaused: () => {
          const snapshot = clock.snapshot();
          return snapshot.started ? snapshot.paused === true : undefined;
        },
      }),
    });
    expect((await join('Guest', 'operations_director')).status).toBe(200);
    const service = await connectService();
    const screen = await connectMeetingClient(portOf(app), app.meetingId, 'screen');

    await settle(30);
    expect(runnerStates(service.messages).length).toBeGreaterThan(0);
    const before = (await runnerState()).version;

    expect((await startMeeting()).status).toBe(200);
    const running = await waitFor(
      () => runnerStates(service.messages).find((state) => state.phase === 'running'),
      'a running RUNNER_STATE',
    );
    expect(running.started).toBe(true);
    expectNewerThan(running.version, before);

    screen.ws.send(JSON.stringify({ type: 'NEXT_AGENDA_ITEM' }));
    const moved = await waitFor(
      () => runnerStates(service.messages).find((state) => state.agendaIndex === 1),
      'an agenda-move RUNNER_STATE',
    );
    expect(moved.phase).toBe('running');

    // A practice screen may not send SET_PAUSED; drive the clock the module reads, then let the
    // server publish a fresh snapshot from a record update.
    clock.pause('person');
    app.hub.publish({
      type: 'MEETING_RECORD_UPDATED',
      audience: { kind: 'all' },
      payload: { agendaIndex: 1, openQuestions: [], elapsedSeconds: 1, speakerTalkSeconds: {} },
    });
    const paused = await waitFor(
      () => runnerStates(service.messages).find((state) => state.paused === true),
      'a paused RUNNER_STATE',
    );
    expectNewerThan(paused.version, moved.version);

    app.session.reset();
    const reset = await waitFor(
      () =>
        [...runnerStates(service.messages)]
          .reverse()
          .find(
            (state) =>
              state.phase === 'lobby' && state.started === false && state.version.seq > paused.version.seq,
          ),
      'a reset RUNNER_STATE',
    );
    expectNewerThan(reset.version, paused.version);
    screen.close();
  });

  it('does not change agenda or cast when a guest drops and rejoins mid-meeting', async () => {
    let roster: Array<{ name: string }> = [];
    const scenario = await loadScenario('kopitiam');
    app = await createRealTestApp(
      {
        speechRecognition: 'browser',
        scenario,
        serviceToken: TOKEN,
        roomRoster: async () => roster,
        rejoinGraceMs: 60_000,
        rejoinPollMs: 60_000,
      },
      { title: 'Weekly planning', agenda: scenario.agenda.slice(0, 2) },
    );
    const service = await connectService();
    const joinReal = (name: string) => fetch(meetingUrl(app!, app!.meetingId, '/api/livekit/token'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ participantName: name, participantRole: 'operations_director' }),
    });
    expect((await joinReal('Guest')).status).toBe(200);
    expect((await startMeeting()).status).toBe(200);
    await waitFor(
      () => runnerStates(service.messages).find((state) => state.phase === 'running'),
      'a running RUNNER_STATE',
    );
    const before = await runnerState();

    roster = [];
    await settle(20);
    expect((await joinReal('Guest')).status).toBe(200);
    await settle(30);

    const after = await runnerState();
    expect(after.meetingId).toBe(before.meetingId);
    expect(after.agenda).toEqual(before.agenda);
    expect(after.cast).toEqual(before.cast);
  });
});
