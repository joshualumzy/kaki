import { CONTROL_TOPIC, parseScenario, roleForZoomName, setMeetingAgenda, STT_TOPIC, type Scenario } from '@kaki/shared';
import { describe, expect, it, vi } from 'vitest';
import { loadScenario } from '../../src/loadScenario';
import { openingLine } from '../../src/host/opening';
import { DEFAULT_TOPIC_TIME_BUDGET_MS } from '../../src/npc/conversation';
import { createMeetingSync } from '../../src/npc/meetingSync';
import { startNpcRunner, visitorDispatchLine, type RunnerMeetingState } from '../../src/npc/runner';

const rooms = vi.hoisted(() => [] as Array<{ emit(event: string, ...args: unknown[]): void; connected?: boolean }>);
const published = vi.hoisted(() => [] as Array<{ topic?: string; message: unknown }>);
const tokens = vi.hoisted(() => [] as string[]);
const startup = vi.hoisted(() => ({ hold: false, release: undefined as undefined | (() => void) }));

vi.mock('../../src/livekit', () => ({
  createRoomToken: async (options: { participantName: string }) => {
    tokens.push(options.participantName);
    return 'offline-token';
  },
}));
vi.mock('@livekit/rtc-node', () => {
  class Room {
    connected = false;
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
    async connect() { this.connected = true; return undefined; }
    async disconnect() { this.connected = false; return undefined; }
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

describe('startNpcRunner visitor pointer count', () => {
  it('points at the card once per topic, however many dispatches arrive', async () => {
    rooms.length = 0;
    const scenario = await loadScenario('kopitiam');
    const transcript: string[] = [];
    const runner = await startNpcRunner({
      scenario,
      livekitUrl: 'ws://offline.invalid',
      stream: async function* () {},
      synthesize: async () => new Int16Array(),
      postTranscript: (_speaker, text) => transcript.push(text),
      responseDelayMs: 0,
      speakerGapMs: 0,
      sentenceGapMs: 0,
    });
    try {
      const participant = { identity: 'visitor-1', name: 'Daniel', metadata: 'producer' };
      rooms[0]!.emit('participantConnected', participant);
      await vi.waitFor(() => expect(runner.plays('Arjun')).toBe(true));
      await runner.markStarted();
      await vi.waitFor(() => expect(transcript.some((line) => line.startsWith('Welcome to'))).toBe(true));
      const dispatch = (title: string): string =>
        `Daniel, I've sent you a task: ${title}. Accept or decline it on your phone.`;

      runner.announce(dispatch('Send the note'));
      await vi.waitFor(() => expect(transcript.filter((line) => line.includes("the follow-up's on your screen"))).toHaveLength(1));
      runner.announce(dispatch('Book the call'));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(transcript.filter((line) => line.includes("on your screen"))).toHaveLength(1);

      runner.agendaMoved(scenario.agenda[1]?.title);
      runner.announce(dispatch('Check the till'));
      await vi.waitFor(() => expect(transcript.filter((line) => line.includes("the follow-up's on your screen"))).toHaveLength(2));
    } finally {
      await runner.stop();
    }
  });
});

describe('startNpcRunner topic transition', () => {
  it('does not invite the visitor over the colleague brief that follows', async () => {
    rooms.length = 0;
    const scenario = await loadScenario('kopitiam');
    const transcript: string[] = [];
    const runner = await startNpcRunner({
      scenario,
      livekitUrl: 'ws://offline.invalid',
      stream: async function* () {},
      synthesize: async () => new Int16Array(),
      postTranscript: (_speaker, text) => transcript.push(text),
      responseDelayMs: 0,
      speakerGapMs: 0,
      sentenceGapMs: 0,
    });
    try {
      const listener = rooms[0]!;
      const participant = { identity: 'visitor-1', name: 'Daniel', metadata: 'producer' };
      listener.emit('participantConnected', participant);
      await vi.waitFor(() => expect(runner.plays('Arjun')).toBe(true));
      await runner.markStarted();
      await vi.waitFor(() => expect(transcript.some((line) => line.startsWith('Welcome to'))).toBe(true));
      runner.agendaMoved(scenario.agenda[1]!.title);
      runner.announce('Next up: the kopi prices.');
      await vi.waitFor(() => expect(transcript.some((line) => line.includes('move on to the kopi prices'))).toBe(true));
      const line = transcript.find((entry) => entry.includes('move on to the kopi prices'))!;
      expect(line).not.toContain('over to you');
    } finally {
      await runner.stop();
    }
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
      await runner.markStarted();
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

describe('server-owned start preparation', () => {
  it('initializes the cast for a Start without speaking, so a timed-out Start never opens', async () => {
    rooms.length = 0;
    published.length = 0;
    startup.hold = false;
    startup.release = undefined;
    const scenario = await loadScenario('kopitiam');
    const transcript: string[] = [];
    const runner = await startNpcRunner({
      scenario,
      livekitUrl: 'ws://offline.invalid',
      stream: async function* () {},
      synthesize: async () => new Int16Array(),
      postTranscript: (_speaker, text) => transcript.push(text),
      responseDelayMs: 0,
      speakerGapMs: 0,
      sentenceGapMs: 0,
    });
    try {
      const participant = { identity: 'visitor-1', name: 'Booth Playtest', metadata: 'producer' };
      // Hold the cast join that the arriving person triggers, then queue the server's prepare behind it.
      startup.hold = true;
      rooms[0]!.emit('participantConnected', participant);
      await vi.waitFor(() => expect(startup.release).toBeTypeOf('function'));

      const prepared = runner.prepareMeeting({ meetingId: 'meeting-1', attempt: 'attempt-1' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(transcript.some((line) => line.startsWith('Welcome to'))).toBe(false);

      startup.release!();
      await prepared;
      expect(runner.wasPreparedFor('meeting-1')).toBe(true);
      // Preparing is not opening: a server Start that timed out must leave the room silent.
      expect(transcript.some((line) => line.startsWith('Welcome to'))).toBe(false);

      await runner.markStarted({ meetingId: 'meeting-1' });
      await vi.waitFor(() => expect(transcript.some((line) => line.startsWith('Welcome to'))).toBe(true));
    } finally {
      await runner.stop();
    }
  });

  it('fetches the authoritative cast before computing who to connect during prepare', async () => {
    rooms.length = 0;
    tokens.length = 0;
    const scenario = await loadScenario('kopitiam');
    const pack = structuredClone(scenario);
    let latest: Scenario = { ...pack, npcs: (pack.npcs ?? []).filter((npc) => npc.role === 'host') };
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
      const participant = { identity: 'visitor-1', name: 'Booth Playtest', metadata: 'producer' };
      rooms[0]!.emit('participantConnected', participant);
      await vi.waitFor(() => expect(tokens).toContain('Sam'));
      expect(tokens).not.toContain('Arjun');

      // The cast changes only now; preparation must fetch it before deciding who joins.
      latest = { ...pack, agenda: pack.agenda.slice(0, 2) };
      await runner.prepareMeeting({ meetingId: 'meeting-1', attempt: 'attempt-1' });
      expect(tokens).toContain('Arjun');
      expect(tokens).toContain('Mei');
      expect(runner.plays('Arjun')).toBe(true);
    } finally {
      await runner.stop();
    }
  });

  it('rejects preparation when the scenario cannot be fetched', async () => {
    rooms.length = 0;
    const scenario = await loadScenario('kopitiam');
    const runner = await startNpcRunner({
      scenario,
      livekitUrl: 'ws://offline.invalid',
      stream: async function* () {},
      synthesize: async () => new Int16Array(),
      postTranscript: () => undefined,
      fetchScenario: async () => {
        throw new Error('offline');
      },
      responseDelayMs: 0,
    });
    try {
      await expect(
        runner.prepareMeeting({ meetingId: 'meeting-1', attempt: 'attempt-1' }),
      ).rejects.toThrow(/scenario could not be fetched: offline/);
    } finally {
      await runner.stop();
    }
  });

  it('never hands the opening to a character outside the active cast', async () => {
    rooms.length = 0;
    published.length = 0;
    const scenario = await loadScenario('kopitiam');
    const pack = structuredClone(scenario);
    const latest = { ...pack, npcs: (pack.npcs ?? []).filter((npc) => npc.attendee !== 'Mei') };
    const transcript: string[] = [];
    const runner = await startNpcRunner({
      scenario,
      livekitUrl: 'ws://offline.invalid',
      stream: async function* () {},
      synthesize: async () => new Int16Array(),
      postTranscript: (_speaker, text) => transcript.push(text),
      fetchScenario: async () => latest,
      responseDelayMs: 0,
      speakerGapMs: 0,
      sentenceGapMs: 0,
    });
    try {
      rooms[0]!.emit('participantConnected', { identity: 'visitor-1', name: 'Booth Playtest', metadata: 'producer' });
      await vi.waitFor(() => expect(runner.plays('Arjun')).toBe(true));
      await runner.markStarted({ meetingId: 'meeting-1' });
      await vi.waitFor(() => expect(transcript.some((line) => line.includes('what happened'))).toBe(true));
      const spoken = transcript.join(' ');
      expect(spoken).not.toContain('Mei');
      expect(spoken).toContain('Daniel, what happened?');
    } finally {
      await runner.stop();
    }
  });

  it('acks preparation with a zero-AI cast, disconnecting previous voices', async () => {
    rooms.length = 0;
    tokens.length = 0;
    const scenario = await loadScenario('kopitiam');
    const transcript: string[] = [];
    let latest: Scenario = scenario;
    const runner = await startNpcRunner({
      scenario,
      livekitUrl: 'ws://offline.invalid',
      stream: async function* () {},
      synthesize: async () => new Int16Array(),
      postTranscript: (_speaker, text) => transcript.push(text),
      fetchScenario: async () => latest,
      responseDelayMs: 0,
    });
    try {
      const participant = { identity: 'visitor-1', name: 'Booth Playtest', metadata: 'producer' };
      rooms[0]!.emit('participantConnected', participant);
      await vi.waitFor(() => expect(runner.plays('Arjun')).toBe(true));
      const voices = rooms.slice(1);
      expect(voices.length).toBeGreaterThan(0);
      expect(voices.every((room) => room.connected === true)).toBe(true);

      latest = { ...scenario, npcs: [] };
      await expect(
        runner.prepareMeeting({ meetingId: 'meeting-1', attempt: 'attempt-1' }),
      ).resolves.toBeUndefined();
      expect(runner.plays('Arjun')).toBe(false);
      await vi.waitFor(() => expect(voices.every((room) => room.connected === false)).toBe(true));

      await runner.markStarted({ meetingId: 'meeting-1' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(transcript.some((line) => line.startsWith('Welcome to'))).toBe(false);
    } finally {
      await runner.stop();
    }
  });

  it('ignores a browser LiveKit Start and waits for the server', async () => {
    rooms.length = 0;
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
      const participant = { identity: 'visitor-1', name: 'Booth Playtest', metadata: 'producer' };
      rooms[0]!.emit('participantConnected', participant);
      await vi.waitFor(() => expect(runner.plays('Arjun')).toBe(true));

      rooms[0]!.emit(
        'dataReceived',
        new TextEncoder().encode(JSON.stringify({ kind: 'start' })),
        participant,
        undefined,
        CONTROL_TOPIC,
      );
      await vi.waitFor(() => expect(log.some((line) => line.includes('ignored a LiveKit Start'))).toBe(true));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(transcript.some((line) => line.startsWith('Welcome to'))).toBe(false);
      expect(runner.meetingId()).toBeUndefined();
    } finally {
      await runner.stop();
    }
  });

  it('clears the old meeting after a missed reset and really opens the new one', async () => {
    rooms.length = 0;
    published.length = 0;
    startup.hold = false;
    const scenario = await loadScenario('kopitiam');
    const transcript: string[] = [];
    const runner = await startNpcRunner({
      scenario,
      livekitUrl: 'ws://offline.invalid',
      stream: async function* () {},
      synthesize: async () => new Int16Array(),
      postTranscript: (_speaker, text) => transcript.push(text),
      responseDelayMs: 0,
      speakerGapMs: 0,
      sentenceGapMs: 0,
    });
    try {
      const participant = { identity: 'visitor-1', name: 'Booth Playtest', metadata: 'producer' };
      rooms[0]!.emit('participantConnected', participant);
      await vi.waitFor(() => expect(runner.plays('Arjun')).toBe(true));
      await runner.markStarted({ meetingId: 'meeting-1' });
      await vi.waitFor(() => expect(transcript.filter((line) => line.startsWith('Welcome to'))).toHaveLength(1));

      // The service socket was down for the reset; its reconnect fetch shows a different meeting.
      runner.reconcileMeeting({ meetingId: 'meeting-2', started: false });
      expect(runner.meetingId()).toBe('meeting-2');
      await expect(runner.markStarted({ meetingId: 'meeting-1' })).rejects.toThrow(/this runner is on meeting-2/);

      await runner.prepareMeeting({ meetingId: 'meeting-2', attempt: 'attempt-2' });
      await runner.markStarted({ meetingId: 'meeting-2' });
      await vi.waitFor(() => expect(transcript.filter((line) => line.startsWith('Welcome to'))).toHaveLength(2));
      await vi.waitFor(() => expect(runner.onCurrentAgenda(scenario.agenda[0]!.title)).toBe(true));
    } finally {
      await runner.stop();
    }
  });

  it('lets a new visitor session start after the server resets the meeting', async () => {
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
      await runner.markStarted({ meetingId: 'meeting-1' });
      await vi.waitFor(() => expect(transcript.filter((line) => line.startsWith('Welcome to'))).toHaveLength(1));
      rooms[0]!.emit('participantDisconnected', first);
      await new Promise((resolve) => setTimeout(resolve, 20));
      // The server's MEETING_RESET arrives after the grace window: no rejoin, a fresh meeting.
      runner.resetMeeting('meeting-2');
      const second = { identity: 'visitor-2', name: 'Second Visitor', metadata: 'producer' };
      rooms[0]!.emit('participantConnected', second);
      await vi.waitFor(() => expect(runner.plays('Arjun')).toBe(true));
      await runner.markStarted({ meetingId: 'meeting-2' });
      await vi.waitFor(() => expect(transcript.filter((line) => line.startsWith('Welcome to'))).toHaveLength(2));
    } finally {
      await runner.stop();
    }
  });

  it('pauses when the room empties and says one welcome-back line on return', async () => {
    rooms.length = 0;
    published.length = 0;
    const scenario = await loadScenario('kopitiam');
    const transcript: string[] = [];
    const pauses: boolean[] = [];
    const log: string[] = [];
    const runner = await startNpcRunner({
      scenario,
      livekitUrl: 'ws://offline.invalid',
      stream: async function* () {},
      synthesize: async () => new Int16Array(),
      postTranscript: (_speaker, text) => transcript.push(text),
      log: (line) => log.push(line),
      onPauseChange: (paused) => pauses.push(paused),
      responseDelayMs: 0,
    });
    try {
      const first = { identity: 'visitor-1', name: 'Booth Playtest', metadata: 'producer' };
      rooms[0]!.emit('participantConnected', first);
      await vi.waitFor(() => expect(runner.plays('Arjun')).toBe(true));
      await runner.markStarted({ meetingId: 'meeting-1' });
      await vi.waitFor(() => expect(transcript.filter((line) => line.startsWith('Welcome to'))).toHaveLength(1));

      rooms[0]!.emit('participantDisconnected', first);
      await vi.waitFor(() => expect(pauses).toContain(true));
      expect(log.some((line) => line.includes('paused in case someone returns'))).toBe(true);

      const back = { identity: 'visitor-1', name: 'Booth Playtest', metadata: 'producer' };
      rooms[0]!.emit('participantConnected', back);
      await vi.waitFor(() => expect(pauses.at(-1)).toBe(false));
      await vi.waitFor(() => expect(transcript.filter((line) => line.startsWith('Welcome back')).length).toBe(1));

      // The same person starts again (a page refresh, then the server's no-op Start): no second welcome.
      await runner.markStarted({ meetingId: 'meeting-1' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(transcript.filter((line) => line.startsWith('Welcome to'))).toHaveLength(1);
      expect(transcript.filter((line) => line.startsWith('Welcome back'))).toHaveLength(1);
    } finally {
      await runner.stop();
    }
  });
});

describe('startNpcRunner serialized start', () => {
  it('opens the first topic even when the welcome cue wins the race with the cast queue', async () => {
    rooms.length = 0;
    const scenario = await loadScenario('kopitiam');
    const transcript: string[] = [];
    const runner = await startNpcRunner({
      scenario,
      livekitUrl: 'ws://offline.invalid',
      stream: async function* () {},
      synthesize: async () => new Int16Array(),
      postTranscript: (_speaker, text) => transcript.push(text),
      responseDelayMs: 0,
      speakerGapMs: 0,
      sentenceGapMs: 0,
    });
    try {
      const listener = rooms[0]!;
      const participant = { identity: 'visitor-1', name: 'Daniel', metadata: 'producer' };
      listener.emit('participantConnected', participant);
      await vi.waitFor(() => expect(runner.plays('Arjun')).toBe(true));

      const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      const opening = runner.markStarted();
      // A coalesced host cue: the welcome is spoken before the queued syncCast has run.
      runner.announce(openingLine(scenario));
      try {
        await opening;

        await vi.waitFor(() => expect(runner.onCurrentAgenda(scenario.agenda[0]!.title)).toBe(true));
        // Opening the topic is a real initialization, not just the default agenda item: its timer is armed.
        expect(timeoutSpy.mock.calls.some((call) => call[1] === DEFAULT_TOPIC_TIME_BUDGET_MS)).toBe(true);
      } finally {
        timeoutSpy.mockRestore();
      }
    } finally {
      await runner.stop();
    }
  });

  it('resumes a restored meeting at the saved item without a second welcome', async () => {
    rooms.length = 0;
    const scenario = await loadScenario('kopitiam');
    const restoredOrder = [scenario.agenda[1]!, scenario.agenda[0]!, ...scenario.agenda.slice(2)];
    const transcript: string[] = [];
    const runner = await startNpcRunner({
      scenario,
      livekitUrl: 'ws://offline.invalid',
      stream: async function* () {},
      synthesize: async () => new Int16Array(),
      postTranscript: (_speaker, text) => transcript.push(text),
      fetchScenario: async () => ({ ...scenario, agenda: restoredOrder }),
      responseDelayMs: 0,
      speakerGapMs: 0,
      sentenceGapMs: 0,
    });
    try {
      const listener = rooms[0]!;
      await runner.markStarted({ agendaIndex: 1, resumed: true });
      const participant = { identity: 'visitor-1', name: 'Daniel', metadata: 'producer' };
      listener.emit('participantConnected', participant);

      await vi.waitFor(() => expect(runner.onCurrentAgenda(restoredOrder[1]!.title)).toBe(true));
      expect(runner.onCurrentAgenda(restoredOrder[0]!.title)).toBe(false);
      expect(transcript.some((line) => line.startsWith('Welcome to'))).toBe(false);
    } finally {
      await runner.stop();
    }
  });
});

describe('meeting sync with the real runner', () => {
  const participant = { identity: 'visitor-1', name: 'Booth Playtest', metadata: 'producer' };

  async function openRunner(transcript: string[]) {
    const scenario = await loadScenario('kopitiam');
    const runner = await startNpcRunner({
      scenario,
      livekitUrl: 'ws://offline.invalid',
      stream: async function* () {},
      synthesize: async () => new Int16Array(),
      postTranscript: (_speaker, text) => transcript.push(text),
      responseDelayMs: 0,
      speakerGapMs: 0,
      sentenceGapMs: 0,
    });
    rooms[0]!.emit('participantConnected', participant);
    await vi.waitFor(() => expect(runner.plays('Arjun')).toBe(true));
    return { runner, scenario };
  }

  it('opens a prepared meeting from hydration first, and the retained replay adds no second welcome', async () => {
    rooms.length = 0;
    const transcript: string[] = [];
    const { runner, scenario } = await openRunner(transcript);
    try {
      await runner.prepareMeeting({ meetingId: 'meeting-1', attempt: 'attempt-1' });
      const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      try {
        // The retained MEETING_STARTED was lost with the socket; HTTP hydration arrives first and
        // must still open this prepared meeting as a fresh start, welcome included.
        const state: RunnerMeetingState = { meetingId: 'meeting-1', started: true, agendaIndex: 0 };
        const sync = createMeetingSync({ runner, fetchState: async () => state, log: () => undefined });

        sync.connected();
        await vi.waitFor(() => expect(transcript.filter((line) => line.startsWith('Welcome to'))).toHaveLength(1));
        await vi.waitFor(() => expect(runner.onCurrentAgenda(scenario.agenda[0]!.title)).toBe(true));
        // Opening the topic is a real initialization: its timer is armed, not just the default item.
        expect(timeoutSpy.mock.calls.some((call) => call[1] === DEFAULT_TOPIC_TIME_BUDGET_MS)).toBe(true);

        // The retained event catches up afterwards; it must not welcome the guest a second time.
        sync.started({ meetingId: 'meeting-1', agendaIndex: 0, resumed: false });
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(transcript.filter((line) => line.startsWith('Welcome to'))).toHaveLength(1);
        await vi.waitFor(() => expect(runner.onCurrentAgenda(scenario.agenda[0]!.title)).toBe(true));
      } finally {
        timeoutSpy.mockRestore();
      }
    } finally {
      await runner.stop();
    }
  });

  it('opens a prepared meeting from MEETING_STARTED first with one welcome, even after a later hydration', async () => {
    rooms.length = 0;
    const transcript: string[] = [];
    const { runner, scenario } = await openRunner(transcript);
    try {
      await runner.prepareMeeting({ meetingId: 'meeting-1', attempt: 'attempt-1' });
      const state: RunnerMeetingState = { meetingId: 'meeting-1', started: true, agendaIndex: 0 };
      const sync = createMeetingSync({ runner, fetchState: async () => state, log: () => undefined });

      sync.started({ meetingId: 'meeting-1', agendaIndex: 0, resumed: false });
      await vi.waitFor(() => expect(transcript.filter((line) => line.startsWith('Welcome to'))).toHaveLength(1));
      await vi.waitFor(() => expect(runner.onCurrentAgenda(scenario.agenda[0]!.title)).toBe(true));

      sync.connected();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(transcript.filter((line) => line.startsWith('Welcome to'))).toHaveLength(1);
    } finally {
      await runner.stop();
    }
  });
});
