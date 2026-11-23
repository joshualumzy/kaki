import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, type KakiApp } from '../src/app';
import { createMeetingModule } from '../src/host/meeting';
import { createFakeLlm } from '../src/services/llm';
import {
  connectMeetingClient,
  createRealTestApp,
  meetingUrl,
  portOf,
  realModulesWith,
  waitFor,
} from './helpers';
import { testScenario } from './fixtures/scenario';

const removals = vi.hoisted(() => [] as string[]);

vi.mock('../src/services/livekit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/livekit')>()),
  removeRoomHumans: async (roomName: string) => {
    removals.push(roomName);
  },
}));

const apps: KakiApp[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  removals.splice(0);
  vi.restoreAllMocks();
});

describe('ending a meeting keeps its room', () => {
  it('does not remove the people who stay to review and publish the minutes', async () => {
    const app = await createRealTestApp(
      {
        scenario: testScenario,
        roomRoster: async () => [],
        speechRecognition: 'browser',
        rejoinGraceMs: 60_000,
        meetingModules: realModulesWith([
          createMeetingModule({ llm: createFakeLlm(() => '{}'), notetakerIntervalMs: 60_000 }),
        ]),
      },
      { title: 'Weekly planning' },
    );
    try {
      const port = portOf(app);
      const joined = await fetch(meetingUrl(app, app.meetingId, '/api/livekit/token'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ participantName: 'Ada', participantRole: 'chef' }),
      });
      expect(joined.status).toBe(200);
      expect((await fetch(meetingUrl(app, app.meetingId, '/api/meeting/start'), { method: 'POST' })).status).toBe(200);
      await waitFor(() => (app.session.phase() === 'running' ? true : undefined), 'the meeting to run');
      // Opening and taking the first seat clear the old lobby; only what END does now matters.
      removals.splice(0);

      const screen = await connectMeetingClient(port, app.meetingId, 'screen');
      screen.ws.send(JSON.stringify({ type: 'END_MEETING' }));
      await waitFor(() => (app.session.phase() === 'ended' ? true : undefined), 'the meeting to end');

      expect(app.session.holders()).toHaveLength(1);
      expect(removals).toEqual([]);

      screen.ws.send(JSON.stringify({ type: 'NEW_MEETING' }));
      await waitFor(() => (app.session.phase() === 'lobby' ? true : undefined), 'the reset');
      expect(removals).toHaveLength(1);
      screen.close();
    } finally {
      await app.close();
    }
  });

  it('keeps the practice visitor in the room for wrap-up and minutes, and removes them on the reset', async () => {
    const app = await createApp({
      scenario: testScenario,
      roomRoster: async () => [],
      speechRecognition: 'browser',
      rejoinGraceMs: 60_000,
    });
    apps.push(app);
    const port = portOf(app);
    const created = await fetch(`http://127.0.0.1:${port}/api/practice`, { method: 'POST' });
    expect(created.status).toBe(200);
    const cookie = created.headers.get('set-cookie')?.split(';')[0] ?? '';
    const { meetingId } = (await created.json()) as { meetingId: string };
    const joined = await fetch(`http://127.0.0.1:${port}/api/meetings/${meetingId}/livekit/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ participantName: 'Ada', participantRole: 'chef', kind: 'practice' }),
    });
    expect(joined.status).toBe(200);
    const started = await fetch(`http://127.0.0.1:${port}/api/meetings/${meetingId}/meeting/start`, {
      method: 'POST',
      headers: { cookie },
    });
    expect(started.status).toBe(200);
    const instance = app.registry.findPractice(meetingId);
    await waitFor(() => (instance?.session.phase() === 'running' ? true : undefined), 'the practice meeting to run');
    removals.splice(0);

    instance?.session.end();

    // The visitor stays to receive the closing cue, the frozen record and the minutes card.
    expect(instance?.session.phase()).toBe('ended');
    expect(removals).toEqual([]);

    instance?.session.reset();
    await waitFor(() => (removals.length > 0 ? true : undefined), 'the practice room removal on reset');
    expect(removals).toHaveLength(1);
  });
});
