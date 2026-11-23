import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { KakiEvent } from '@kaki/shared';
import { loadScenario } from '../../src/core/loadScenario';
import { createRunnerClient } from '../../src/npc/runnerClient';
import { startNpcRunner, type NpcRunner } from '../../src/npc/runner';
import type { Recognizer } from '../../src/npc/utterance';
import {
  createRealTestApp,
  meetingPath,
  meetingUrl,
  meetingWsUrl,
  portOf,
  waitFor,
  type TestAppWithMeeting,
} from '../helpers';

const TOKEN = 'local-test-runner-token';
const audio = vi.hoisted(() => ({ frames: [] as Int16Array[] }));
const rooms = vi.hoisted(() => [] as Array<{ emit(event: string, ...args: unknown[]): void }>);

vi.mock('../../src/services/livekit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/livekit')>()),
  createRoomToken: async () => 'offline-token',
}));

vi.mock('@livekit/rtc-node', () => {
  class Room {
    connected = false;
    handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    remoteParticipants = new Map();
    localParticipant = {
      publishTrack: async () => undefined,
      publishData: async () => undefined,
    };
    constructor() {
      rooms.push(this);
    }
    on(event: string, handler: (...args: unknown[]) => void) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    }
    emit(event: string, ...args: unknown[]) {
      for (const handler of this.handlers.get(event) ?? []) handler(...args);
    }
    async connect() {
      this.connected = true;
      return undefined;
    }
    async disconnect() {
      this.connected = false;
      return undefined;
    }
  }
  class AudioStream {
    async *[Symbol.asyncIterator]() {
      while (audio.frames.length > 0) {
        yield { data: audio.frames.shift()!, sampleRate: 16_000 };
      }
    }
  }
  return {
    Room,
    RoomEvent: {
      ParticipantConnected: 'participantConnected',
      ParticipantDisconnected: 'participantDisconnected',
      TrackSubscribed: 'trackSubscribed',
      DataReceived: 'dataReceived',
      Disconnected: 'disconnected',
    },
    AudioSource: class {},
    AudioStream,
    LocalAudioTrack: { createAudioTrack: () => ({}) },
    TrackPublishOptions: class {},
    TrackSource: { SOURCE_MICROPHONE: 1 },
    TrackKind: { KIND_AUDIO: 1 },
  };
});

const apps: TestAppWithMeeting[] = [];
const sockets: WebSocket[] = [];
const runners: NpcRunner[] = [];

afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop().catch(() => undefined);
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const app of apps.splice(0)) await app.close();
  audio.frames.length = 0;
  rooms.length = 0;
});

function connect(
  port: number,
  meetingId: string,
  role: string,
  token?: string,
): Promise<{ ws: WebSocket; messages: KakiEvent[] }> {
  const headers: Record<string, string> = token === undefined ? {} : { authorization: `Bearer ${token}` };
  const ws = new WebSocket(meetingWsUrl(port, meetingId, `role=${encodeURIComponent(role)}`), { headers });
  const messages: KakiEvent[] = [];
  ws.on('message', (data) => messages.push(JSON.parse(data.toString()) as KakiEvent));
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve({ ws, messages }));
    ws.once('error', reject);
  });
}

describe('the runner\'s real recognised-speech path reaches the server writer', () => {
  it('posts one human line from a mocked recogniser with the meeting, identity and seat', async () => {
    const pack = await loadScenario('kopitiam');
    const app = await createRealTestApp(
      { scenario: pack, serviceToken: TOKEN, roomRoster: async () => [] },
      {
        title: 'Opening huddle',
        agenda: [{ title: 'Opening checklist', minutes: 5 }],
      },
    );
    apps.push(app);
    const port = portOf(app);

    const service = await connect(port, app.meetingId, 'service', TOKEN);
    sockets.push(service.ws);

    expect(
      (await fetch(meetingUrl(app, app.meetingId, '/api/meeting/open'), { method: 'POST' })).status,
    ).toBe(200);
    const join = async (participantName: string): Promise<string> => {
      const response = await fetch(meetingUrl(app, app.meetingId, '/api/livekit/token'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomName: 'room', participantName }),
      });
      expect(response.status).toBe(200);
      return ((await response.json()) as { participantRole: string }).participantRole;
    };
    await join('Alice');
    await join('Ben');

    const screen = await connect(port, app.meetingId, 'screen', TOKEN);
    sockets.push(screen.ws);
    expect(
      (await fetch(meetingUrl(app, app.meetingId, '/api/meeting/start'), { method: 'POST' })).status,
    ).toBe(200);
    await waitFor(() => (app.session.phase() === 'running' ? true : undefined), 'the meeting to run');

    const aliceSeat = app.session.holders().find((holder) => holder.name.toLowerCase() === 'alice')?.seat;
    if (aliceSeat === undefined) throw new Error('Alice did not take a seat');

    const client = createRunnerClient({
      baseUrl: `http://127.0.0.1:${port}`,
      apiPrefix: meetingPath(app.meetingId, '/api').replace(/\/$/, ''),
      serviceToken: TOKEN,
    });
    const recognizer: Recognizer = {
      start: () => ({
        push: () => undefined,
        finish: async () => 'The queue is out the door.',
        cancel: () => undefined,
      }),
    };
    const failures: string[] = [];
    const runner = await startNpcRunner({
      scenario: pack,
      livekitUrl: 'ws://offline.invalid',
      stream: async function* () {},
      synthesize: async () => new Int16Array(),
      postTranscript: () => undefined,
      postTranscriptUpdate: () => undefined,
      postHumanLine: (line) => {
        void client
          .postHumanLine(line)
          .then((response) => {
            if (!response.ok) failures.push(`HTTP ${response.status}`);
          })
          .catch((error: unknown) => failures.push(String(error)));
      },
      recognizer,
      vad: { minLevel: 0.01, startMs: 40, hangoverMs: 40 },
      responseDelayMs: 0,
      speakerGapMs: 0,
      sentenceGapMs: 0,
    });
    runners.push(runner);

    const snapshot = await client.fetchMeetingState();
    runner.reconcileMeeting(snapshot, { currentConnection: true, authoritative: true });
    const participant = { identity: 'Alice', name: 'Alice', metadata: aliceSeat };
    rooms[0]!.emit('participantConnected', participant);
    await runner.markStarted({ meetingId: snapshot.meetingId });

    // Loud speech followed by silence: the voice detector opens and closes one utterance.
    for (let index = 0; index < 10; index += 1) audio.frames.push(new Int16Array(640).fill(20_000));
    for (let index = 0; index < 5; index += 1) audio.frames.push(new Int16Array(640));
    rooms[0]!.emit('trackSubscribed', { kind: 1 }, undefined, participant);

    const line = await waitFor(
      () =>
        screen.messages.find(
          (event) => event.type === 'TRANSCRIPT_CHUNK' && event.payload.text === 'The queue is out the door.',
        ),
      'the runner-recognised line at the server writer',
    );
    expect(line).toMatchObject({
      payload: {
        speaker: 'Alice',
        speakerRole: aliceSeat,
        text: 'The queue is out the door.',
        speechStartedAt: expect.any(String),
        speechEndedAt: expect.any(String),
      },
    });
    expect(failures).toEqual([]);
  });
});
