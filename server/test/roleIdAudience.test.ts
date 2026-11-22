import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { KakiEvent, Scenario } from '@kaki/shared';
import { createApp, type KakiApp } from '../src/app';
import { portOf, waitFor } from './helpers';
import { testScenario } from './fixtures/scenario';

const apps: KakiApp[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const app of apps.splice(0)) await app.close();
  vi.restoreAllMocks();
});

const participantRoleScenario: Scenario = {
  ...testScenario,
  roles: [
    { id: 'participant', label: 'Participant' },
    { id: 'chef', label: 'Chef' },
  ],
  attendees: [
    { name: 'Ada', role: 'participant', displayName: 'Ada (Participant)' },
    { name: 'Bao', role: 'chef', displayName: 'Bao (Chef)' },
  ],
  npcs: [
    { attendee: 'Ada', voice: 'v', personality: 'p', agenda: 'a', concerns: [], role: 'participant' },
  ],
};

const personParticipantScenario: Scenario = {
  ...testScenario,
  roles: [
    { id: 'participant', label: 'Participant' },
    { id: 'chef', label: 'Chef' },
  ],
  attendees: [
    { name: 'Ada', role: 'participant', displayName: 'Ada (Participant)' },
    { name: 'Bao', role: 'chef', displayName: 'Bao (Chef)' },
  ],
};

async function openRoleSocket(port: number, role: string, token?: string): Promise<WebSocket> {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  const socket = new WebSocket(
    `ws://127.0.0.1:${port}/ws?role=${encodeURIComponent(role)}`,
    Object.keys(headers).length === 0 ? undefined : { headers },
  );
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      reject(new Error(`socket refused with ${response.statusCode ?? 0}`));
    });
    socket.once('error', reject);
  });
  return socket;
}

describe('a role id that spells a projection audience', () => {
  it('accepts the AI runner on a setup role whose id is participant', async () => {
    const app = await createApp({
      speechRecognition: 'browser',
      scenario: participantRoleScenario,
      serviceToken: 'runner-secret',
    });
    apps.push(app);

    const socket = await openRoleSocket(portOf(app), 'participant', 'runner-secret');
    const messages: KakiEvent[] = [];
    socket.on('message', (data) => messages.push(JSON.parse(data.toString()) as KakiEvent));

    // The runner may send role commands on this AI seat. A missing task is refused by the task
    // store, not by the hub: an audience called `participant` is not the participant projection.
    socket.send(JSON.stringify({ type: 'DECLINE_TASK', taskId: 'missing-task' }));
    const rejected = await waitFor(
      () => messages.find((event) => event.type === 'COMMAND_REJECTED'),
      'the runner command to reach the task store',
    );
    expect(rejected.type).toBe('COMMAND_REJECTED');
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  it('delivers that role its own events when a person takes the seat', async () => {
    // Nobody is in the room yet; the test must not depend on a running LiveKit server.
    const app = await createApp({ speechRecognition: 'browser', scenario: personParticipantScenario, roomRoster: async () => [] });
    apps.push(app);
    const port = portOf(app);

    expect((await fetch(`http://127.0.0.1:${port}/api/meeting/open`, { method: 'POST' })).status).toBe(200);
    const joined = await fetch(`http://127.0.0.1:${port}/api/livekit/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ participantName: 'Ada', participantRole: 'participant' }),
    });
    expect(joined.status).toBe(200);

    const messages: KakiEvent[] = [];
    const socket = await openRoleSocket(port, 'participant');
    socket.on('message', (data) => messages.push(JSON.parse(data.toString()) as KakiEvent));

    const note: KakiEvent = {
      type: 'WINGMAN_NOTE',
      audience: { kind: 'role', role: 'participant' },
      payload: {
        id: 'answer:participant',
        kind: 'answer',
        urgency: 'quiet',
        title: 'Wingman',
        text: 'Prep starts in one minute.',
      },
    };
    app.hub.publish(note);

    const received = await waitFor(
      () => messages.find((event) => event.type === 'WINGMAN_NOTE'),
      'the participant role to receive its own private note',
    );
    expect(received.audience).toEqual({ kind: 'role', role: 'participant' });
  });
});
