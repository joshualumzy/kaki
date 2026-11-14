import { CONTROL_TOPIC, parseScenario, roleForZoomName, setMeetingAgenda, STT_TOPIC } from '@kaki/shared';
import { describe, expect, it, vi } from 'vitest';
import { loadScenario } from '../../src/loadScenario';
import { startNpcRunner, visitorDispatchLine } from '../../src/npc/runner';

const rooms = vi.hoisted(() => [] as Array<{ emit(event: string, ...args: unknown[]): void }>);
const published = vi.hoisted(() => [] as Array<{ topic?: string; message: unknown }>);
const startup = vi.hoisted(() => ({ hold: false, release: undefined as undefined | (() => void) }));

vi.mock('../../src/livekit', () => ({ createRoomToken: async () => 'offline-token' }));
vi.mock('@livekit/rtc-node', () => {
  class Room {
    handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    remoteParticipants = new Map();
    localParticipant = {
      publishTrack: async () => {
        if (startup.hold) {
          startup.hold = false;
          await new Promise<void>((resolve) => { startup.release = resolve; });
        }
      },
      publishData: async (payload: Uint8Array, options?: { topic?: string }) => {
        published.push({ topic: options?.topic, message: JSON.parse(new TextDecoder().decode(payload)) });
      },
    };
    constructor() { rooms.push(this); }
    on(event: string, handler: (...args: unknown[]) => void) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    }
    emit(event: string, ...args: unknown[]) {
      for (const handler of this.handlers.get(event) ?? []) handler(...args);
    }
    async connect() { return undefined; }
    async disconnect() { return undefined; }
  }
  return {
    Room,
    RoomEvent: { ParticipantConnected: 'participantConnected', ParticipantDisconnected: 'participantDisconnected', TrackSubscribed: 'trackSubscribed', DataReceived: 'dataReceived', Disconnected: 'disconnected' },
    AudioSource: class {},
    AudioStream: class {},
    LocalAudioTrack: { createAudioTrack: () => ({}) },
    TrackPublishOptions: class {},
    TrackSource: { SOURCE_MICROPHONE: 1 },
    TrackKind: { KIND_AUDIO: 1 },
  };
});

describe('visitorDispatchLine', () => {
  it('points at the card once on the first dispatch and is brief after', () => {
    expect(visitorDispatchLine('Daniel', 1)).toBe(
      "Daniel, the follow-up's on your screen whenever you want to send it.",
    );
    expect(visitorDispatchLine('Daniel', 2)).toBe(
      "Daniel, the follow-up's still on your screen whenever you're ready.",
    );
  });

  it('never reads the formal task title aloud', () => {
    const title = 'Reply to trial-day customer by 7:30 with goodwill payment, no admission';
    for (const count of [1, 2]) expect(visitorDispatchLine('Daniel', count)).not.toContain(title);
  });
});

describe('startNpcRunner visitor transcript identity', () => {
  it.each([
    ['Operations Director', CONTROL_TOPIC, { kind: 'text', text: 'Typed visitor line' }, 'Typed visitor line'],
    ['producer', STT_TOPIC, { text: 'Recognized visitor line' }, 'Recognized visitor line'],
  ])('attributes %s input on %s to the visitor and preserves the role', async (role, topic, message, line) => {
    rooms.length = 0;
    const scenario = await loadScenario('kopitiam');
    const transcript: Array<[string, string]> = [];
    const runner = await startNpcRunner({
      scenario,
      livekitUrl: 'ws://offline.invalid',
      stream: async function* () {},
      synthesize: async () => new Int16Array(),
      postTranscript: (speaker, text) => transcript.push([speaker, text]),
      responseDelayMs: 0,
    });
    try {
      const listener = rooms[0]!;
      const participant = { identity: 'visitor-1', name: 'Booth Playtest', metadata: role };
      listener.emit('participantConnected', participant);
      await vi.waitFor(() => expect(runner.plays('Arjun')).toBe(true));
      listener.emit('dataReceived', new TextEncoder().encode(JSON.stringify({ kind: 'start' })), participant, undefined, CONTROL_TOPIC);
      listener.emit('dataReceived', new TextEncoder().encode(JSON.stringify(message)), participant, undefined, topic);
      await vi.waitFor(() => expect(transcript.some(([, text]) => text === line)).toBe(true));
      const speaker = transcript.find(([, text]) => text === line)![0];
      expect(speaker).toBe('Booth Playtest (Operations Director)');
      expect(roleForZoomName(scenario, speaker)).toBe('producer');
    } finally {
      await runner.stop();
    }
  });
});

describe('scenario refresh failure', () => {
  it.each([
    ['fetch', async () => { throw new Error('offline'); }, 'offline'],
    ['parse', async () => parseScenario({ agenda: [] }), 'Invalid scenario'],
    ['empty result', async () => undefined, 'no usable scenario returned'],
  ])('logs the %s reason and keeps the current agenda', async (_kind, fetchScenario, reason) => {
    rooms.length = 0;
    const scenario = await loadScenario('kopitiam');
    const original = scenario.agenda.map((item) => item.title);
    const lines: string[] = [];
    const runner = await startNpcRunner({
      scenario,
      livekitUrl: 'ws://offline.invalid',
      stream: async function* () {},
      synthesize: async () => new Int16Array(),
      postTranscript: () => undefined,
      fetchScenario,
      log: (line) => lines.push(line),
      responseDelayMs: 0,
    });
    try {
      rooms[0]!.emit('participantConnected', { identity: 'visitor-1', name: 'Visitor', metadata: 'producer' });
      await vi.waitFor(() => expect(lines.some((line) => line.includes(reason))).toBe(true));
      expect(lines.some((line) => line.includes('keeping current agenda as last resort'))).toBe(true);
      expect(scenario.agenda.map((item) => item.title)).toEqual(original);
    } finally {
      await runner.stop();
    }
  });

  it('updates the shared agenda and references after a successful refresh', async () => {
    rooms.length = 0;
    const scenario = await loadScenario('kopitiam');
    const latest = { ...scenario, agenda: [...scenario.agenda] };
    setMeetingAgenda(latest, scenario, scenario.agenda.slice(0, 2));
    const runner = await startNpcRunner({
      scenario,
      livekitUrl: 'ws://offline.invalid',
      stream: async function* () {},
      synthesize: async () => new Int16Array(),
      postTranscript: () => undefined,
      fetchScenario: async () => latest,
      responseDelayMs: 0,
    });
    try {
      rooms[0]!.emit('participantConnected', { identity: 'visitor-1', name: 'Visitor', metadata: 'producer' });
      await vi.waitFor(() => expect(scenario.agenda).toHaveLength(2));
      expect(parseScenario(JSON.parse(JSON.stringify(scenario)) as unknown).agenda).toHaveLength(2);
    } finally {
      await runner.stop();
    }
  });
});

describe('start receipt acknowledgement', () => {
  const starts = (lines: string[]) => lines.filter((line) => line.includes('started the meeting')).length;
  const startAcks = () => published.filter((entry) => (entry.message as { kind?: string }).kind === 'started');

  it('retries an early Start after the listener is ready and opens exactly once, acknowledging every retry', async () => {
    rooms.length = 0;
    published.length = 0;
    const scenario = await loadScenario('kopitiam');
    const transcript: string[] = [];
    const log: string[] = [];
    const participant = { identity: 'visitor-1', name: 'Booth Playtest', metadata: 'producer' };
    const start = new TextEncoder().encode(
      JSON.stringify({ kind: 'start', requestId: 'req-1', session: 'visitor-1' }),
    );
    startup.hold = true;
    startup.release = undefined;
    const pending = startNpcRunner({
      scenario,
      livekitUrl: 'ws://offline.invalid',
      stream: async function* () {},
      synthesize: async () => new Int16Array(),
      postTranscript: (_speaker, text) => transcript.push(text),
      log: (line) => log.push(line),
      responseDelayMs: 0,
    });
    await vi.waitFor(() => expect(startup.release).toBeTypeOf('function'));
    // The visitor pressed Start before the NPC installed DataReceived: this publish is lost.
    rooms[0]!.emit('dataReceived', start, participant, undefined, CONTROL_TOPIC);
    startup.release!();
    const runner = await pending;
    try {
      rooms[0]!.emit('participantConnected', participant);
      await vi.waitFor(() => expect(runner.plays('Arjun')).toBe(true));
      // The first publish is the retry after the early one was lost before the listener existed.
      rooms[0]!.emit('dataReceived', start, participant, undefined, CONTROL_TOPIC);
      await vi.waitFor(() => expect(starts(log)).toBe(1));
      await vi.waitFor(() => expect(startAcks()).toHaveLength(1));
      expect(startAcks()[0]!.message).toEqual({ kind: 'started', requestId: 'req-1', session: 'visitor-1' });
      // The same request retried again is acknowledged without opening the meeting twice.
      rooms[0]!.emit('dataReceived', start, participant, undefined, CONTROL_TOPIC);
      await vi.waitFor(() => expect(startAcks()).toHaveLength(2));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(starts(log)).toBe(1);
    } finally {
      await runner.stop();
    }
  });

  it('acknowledges each present participant without reopening or welcoming twice', async () => {
    rooms.length = 0;
    published.length = 0;
    const scenario = await loadScenario('kopitiam');
    const transcript: string[] = [];
    const log: string[] = [];
    const runner = await startNpcRunner({
      scenario,
      livekitUrl: 'ws://offline.invalid',
      stream: async function* () {},
      synthesize: async () => new Int16Array(),
      postTranscript: (_speaker, text) => transcript.push(text),
      log: (line) => log.push(line),
      responseDelayMs: 0,
    });
    try {
      const first = { identity: 'visitor-1', name: 'First Visitor', metadata: 'producer' };
      const second = { identity: 'visitor-2', name: 'Second Visitor', metadata: 'marketing_lead' };
      rooms[0]!.emit('participantConnected', first);
      rooms[0]!.emit('participantConnected', second);
      await vi.waitFor(() => expect(runner.plays('Arjun')).toBe(true));

      rooms[0]!.emit('dataReceived', new TextEncoder().encode(JSON.stringify({ kind: 'start', requestId: 'req-1', session: 'visitor-1' })), first, undefined, CONTROL_TOPIC);
      await vi.waitFor(() => expect(starts(log)).toBe(1));
      await vi.waitFor(() => expect(transcript.filter((line) => line.startsWith('Welcome to')).length).toBe(1));

      rooms[0]!.emit('dataReceived', new TextEncoder().encode(JSON.stringify({ kind: 'start', requestId: 'req-2', session: 'visitor-2' })), second, undefined, CONTROL_TOPIC);
      await vi.waitFor(() => expect(startAcks()).toHaveLength(2));
      expect(startAcks().map((entry) => entry.message)).toEqual([
        { kind: 'started', requestId: 'req-1', session: 'visitor-1' },
        { kind: 'started', requestId: 'req-2', session: 'visitor-2' },
      ]);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(starts(log)).toBe(1);
      expect(transcript.filter((line) => line.startsWith('Welcome to'))).toHaveLength(1);
    } finally {
      await runner.stop();
    }
  });

  it('does not acknowledge a start claimed for another participant session', async () => {
    rooms.length = 0;
    published.length = 0;
    const scenario = await loadScenario('kopitiam');
    const log: string[] = [];
    const runner = await startNpcRunner({
      scenario,
      livekitUrl: 'ws://offline.invalid',
      stream: async function* () {},
      synthesize: async () => new Int16Array(),
      postTranscript: () => undefined,
      log: (line) => log.push(line),
      responseDelayMs: 0,
    });
    try {
      const participant = { identity: 'visitor-1', name: 'Booth Playtest', metadata: 'producer' };
      rooms[0]!.emit('participantConnected', participant);
      await vi.waitFor(() => expect(runner.plays('Arjun')).toBe(true));
      const spoofed = new TextEncoder().encode(
        JSON.stringify({ kind: 'start', requestId: 'req-9', session: 'visitor-2' }),
      );
      rooms[0]!.emit('dataReceived', spoofed, participant, undefined, CONTROL_TOPIC);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(starts(log)).toBe(0);
      expect(startAcks()).toHaveLength(0);
    } finally {
      await runner.stop();
    }
  });

  it('lets a new visitor session start after the previous one leaves', async () => {
    rooms.length = 0;
    published.length = 0;
    const scenario = await loadScenario('kopitiam');
    const transcript: string[] = [];
    const log: string[] = [];
    const runner = await startNpcRunner({
      scenario,
      livekitUrl: 'ws://offline.invalid',
      stream: async function* () {},
      synthesize: async () => new Int16Array(),
      postTranscript: (_speaker, text) => transcript.push(text),
      log: (line) => log.push(line),
      responseDelayMs: 0,
    });
    try {
      const first = { identity: 'visitor-1', name: 'Booth Playtest', metadata: 'producer' };
      rooms[0]!.emit('participantConnected', first);
      await vi.waitFor(() => expect(runner.plays('Arjun')).toBe(true));
      rooms[0]!.emit('dataReceived', new TextEncoder().encode(JSON.stringify({ kind: 'start', requestId: 'req-1', session: 'visitor-1' })), first, undefined, CONTROL_TOPIC);
      await vi.waitFor(() => expect(starts(log)).toBe(1));
      rooms[0]!.emit('participantDisconnected', first);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const second = { identity: 'visitor-2', name: 'Second Visitor', metadata: 'producer' };
      rooms[0]!.emit('participantConnected', second);
      await vi.waitFor(() => expect(runner.plays('Arjun')).toBe(true));
      rooms[0]!.emit('dataReceived', new TextEncoder().encode(JSON.stringify({ kind: 'start', requestId: 'req-2', session: 'visitor-2' })), second, undefined, CONTROL_TOPIC);
      await vi.waitFor(() => expect(starts(log)).toBe(2));
    } finally {
      await runner.stop();
    }
  });
});
