import { CONTROL_TOPIC, defaultMeetingSetup, meetingScenarioFromSetup, roleForZoomName, STT_TOPIC } from '@kaki/shared';
import { describe, expect, it, vi } from 'vitest';
import { loadScenario } from '../../src/loadScenario';
import { openingLine } from '../../src/host/opening';
import { DEFAULT_TOPIC_TIME_BUDGET_MS } from '../../src/npc/conversation';
import { createMeetingSync } from '../../src/npc/meetingSync';
import { startNpcRunner, visitorDispatchLine } from '../../src/npc/runner';
import { runnerSnapshot } from '../fixtures/runnerSnapshot';

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
    ['producer', CONTROL_TOPIC, { kind: 'text', text: 'Typed visitor line' }, 'Typed visitor line'],
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

  it('takes the cast from the snapshot it is prepared with, before deciding who to connect', async () => {
    rooms.length = 0;
    tokens.length = 0;
    const scenario = await loadScenario('kopitiam');
    const hostOnly = (scenario.npcs ?? []).filter((npc) => npc.role === 'host');
    const runner = await startNpcRunner({
      scenario,
      livekitUrl: 'ws://offline.invalid',
      stream: async function* () {},
      synthesize: async () => new Int16Array(),
      postTranscript: () => undefined,
      responseDelayMs: 0,
    });
    try {
      const participant = { identity: 'visitor-1', name: 'Booth Playtest', metadata: 'producer' };
      rooms[0]!.emit('participantConnected', participant);
      await vi.waitFor(() => expect(runner.plays('Arjun')).toBe(true));
      tokens.length = 0;

      await runner.prepareMeeting({
        meetingId: 'meeting-1',
        attempt: 'attempt-1',
        snapshot: runnerSnapshot(scenario, { meetingId: 'meeting-1', cast: hostOnly, agenda: scenario.agenda.slice(0, 2) }),
      });
      expect(tokens).not.toContain('Arjun');
      expect(runner.plays('Arjun')).toBe(false);

      // A newer snapshot with the full cast is adopted before the next preparation connects anyone.
      await runner.prepareMeeting({
        meetingId: 'meeting-1',
        attempt: 'attempt-2',
        snapshot: runnerSnapshot(scenario, {
          meetingId: 'meeting-1',
          agenda: scenario.agenda.slice(0, 2),
          version: 2,
        }),
      });
      expect(tokens).toContain('Arjun');
      expect(tokens).toContain('Mei');
      expect(runner.plays('Arjun')).toBe(true);
    } finally {
      await runner.stop();
    }
  });

  it('never hands the opening to a character outside the snapshot cast', async () => {
    rooms.length = 0;
    published.length = 0;
    const scenario = await loadScenario('kopitiam');
    const withoutMei = (scenario.npcs ?? []).filter((npc) => npc.attendee !== 'Mei');
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
      await runner.prepareMeeting({
        meetingId: 'meeting-1',
        attempt: 'attempt-1',
        snapshot: runnerSnapshot(scenario, { meetingId: 'meeting-1', cast: withoutMei }),
      });
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
    const runner = await startNpcRunner({
      scenario,
      livekitUrl: 'ws://offline.invalid',
      stream: async function* () {},
      synthesize: async () => new Int16Array(),
      postTranscript: (_speaker, text) => transcript.push(text),
      responseDelayMs: 0,
    });
    try {
      const participant = { identity: 'visitor-1', name: 'Booth Playtest', metadata: 'producer' };
      rooms[0]!.emit('participantConnected', participant);
      await vi.waitFor(() => expect(runner.plays('Arjun')).toBe(true));
      const voices = rooms.slice(1);
      expect(voices.length).toBeGreaterThan(0);
      expect(voices.every((room) => room.connected === true)).toBe(true);

      await expect(
        runner.prepareMeeting({
          meetingId: 'meeting-1',
          attempt: 'attempt-1',
          snapshot: runnerSnapshot(scenario, { meetingId: 'meeting-1', cast: [], version: 2 }),
        }),
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
      runner.reconcileMeeting(runnerSnapshot(scenario, { meetingId: 'meeting-2' }));
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

  it('leaves the empty-room pause to the server and says one welcome-back line on return', async () => {
    rooms.length = 0;
    published.length = 0;
    const scenario = await loadScenario('kopitiam');
    const transcript: string[] = [];
    const runner = await startNpcRunner({
      scenario,
      livekitUrl: 'ws://offline.invalid',
      stream: async function* () {},
      synthesize: async () => new Int16Array(),
      postTranscript: (_speaker, text) => transcript.push(text),
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
      runner.reconcileMeeting(
        runnerSnapshot(scenario, {
          meetingId: 'meeting-1',
          phase: 'running',
          started: true,
          paused: true,
          pauseKind: 'empty-room',
          version: 2,
        }),
      );

      const back = { identity: 'visitor-1', name: 'Booth Playtest', metadata: 'producer' };
      rooms[0]!.emit('participantConnected', back);
      runner.reconcileMeeting(
        runnerSnapshot(scenario, {
          meetingId: 'meeting-1',
          phase: 'running',
          started: true,
          paused: false,
          version: 3,
        }),
      );
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

  it('does not say welcome back when a person reloads the lobby before Start', async () => {
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
    });
    try {
      const first = { identity: 'visitor-1', name: 'Booth Playtest', metadata: 'producer' };
      rooms[0]!.emit('participantConnected', first);
      await vi.waitFor(() => expect(runner.plays('Arjun')).toBe(true));
      rooms[0]!.emit('participantDisconnected', first);
      await new Promise((resolve) => setTimeout(resolve, 20));

      const back = { identity: 'visitor-1', name: 'Booth Playtest', metadata: 'producer' };
      rooms[0]!.emit('participantConnected', back);
      await vi.waitFor(() => expect(runner.plays('Arjun')).toBe(true));
      await runner.markStarted({ meetingId: 'meeting-1' });
      await vi.waitFor(() => expect(transcript.filter((line) => line.startsWith('Welcome to'))).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, 30));

      // The meeting had not started, so the server never paused it: there is no return to greet.
      expect(transcript.filter((line) => line.startsWith('Welcome back'))).toHaveLength(0);
    } finally {
      await runner.stop();
    }
  });

  it('does not say welcome back after a room blip the server never paused for', async () => {
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
    });
    try {
      const first = { identity: 'visitor-1', name: 'Booth Playtest', metadata: 'producer' };
      rooms[0]!.emit('participantConnected', first);
      await vi.waitFor(() => expect(runner.plays('Arjun')).toBe(true));
      await runner.markStarted({ meetingId: 'meeting-1' });
      await vi.waitFor(() => expect(transcript.filter((line) => line.startsWith('Welcome to'))).toHaveLength(1));

      // The person vanished and came back between two roster polls: the server never paused.
      rooms[0]!.emit('participantDisconnected', first);
      const back = { identity: 'visitor-1', name: 'Booth Playtest', metadata: 'producer' };
      rooms[0]!.emit('participantConnected', back);
      await vi.waitFor(() => expect(runner.plays('Arjun')).toBe(true));

      // The next snapshot is an ordinary agenda move, still running and never paused.
      runner.reconcileMeeting(
        runnerSnapshot(scenario, {
          meetingId: 'meeting-1',
          phase: 'running',
          started: true,
          agendaIndex: 1,
          version: 2,
        }),
      );
      await vi.waitFor(() => expect(runner.onCurrentAgenda(scenario.agenda[1]!.title)).toBe(true));
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(transcript.filter((line) => line.startsWith('Welcome back'))).toHaveLength(0);
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
      initialMeeting: runnerSnapshot(scenario, { agenda: restoredOrder }),
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

describe('boot from a server snapshot', () => {
  it('opens a meeting it booted from even when the same snapshot arrives on reconnect', async () => {
    rooms.length = 0;
    const scenario = await loadScenario('kopitiam');
    const transcript: string[] = [];
    const state = runnerSnapshot(scenario, {
      meetingId: 'meeting-1',
      phase: 'running',
      started: true,
      version: 5,
    });
    const runner = await startNpcRunner({
      scenario,
      livekitUrl: 'ws://offline.invalid',
      stream: async function* () {},
      synthesize: async () => new Int16Array(),
      postTranscript: (_speaker, text) => transcript.push(text),
      initialMeeting: state,
      responseDelayMs: 0,
    });
    try {
      rooms[0]!.emit('participantConnected', { identity: 'visitor-1', name: 'Daniel', metadata: 'producer' });
      await vi.waitFor(() => expect(runner.plays('Arjun')).toBe(true));
      runner.reconcileMeeting(state);
      await vi.waitFor(() => expect(runner.onCurrentAgenda(scenario.agenda[0]!.title)).toBe(true));
      expect(transcript.some((line) => line.startsWith('Welcome to'))).toBe(false);
    } finally {
      await runner.stop();
    }
  });
});

describe('reconnect catch-up', () => {
  it('adopts a higher agenda index once, without announcing an old cue', async () => {
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
      rooms[0]!.emit('participantConnected', { identity: 'visitor-1', name: 'Daniel', metadata: 'producer' });
      await vi.waitFor(() => expect(runner.plays('Arjun')).toBe(true));
      await runner.markStarted({ meetingId: 'meeting-1' });
      await vi.waitFor(() => expect(runner.onCurrentAgenda(scenario.agenda[0]!.title)).toBe(true));
      const before = transcript.length;

      runner.reconcileMeeting(
        runnerSnapshot(scenario, {
          meetingId: 'meeting-1',
          phase: 'running',
          started: true,
          agendaIndex: 1,
          version: 2,
        }),
      );

      expect(runner.onCurrentAgenda(scenario.agenda[1]!.title)).toBe(true);
      expect(runner.onCurrentAgenda(scenario.agenda[0]!.title)).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(transcript.length).toBe(before);
      expect(transcript.some((line) => line.startsWith('Next up'))).toBe(false);
    } finally {
      await runner.stop();
    }
  });
});

describe('setup edits before Start', () => {
  it('rebuilds the conversation so a renamed agenda item keeps its briefing', async () => {
    rooms.length = 0;
    const pack = await loadScenario('kopitiam');
    const bootPack = { ...pack, agenda: pack.agenda.slice(0, 2) };
    const runner = await startNpcRunner({
      scenario: bootPack,
      livekitUrl: 'ws://offline.invalid',
      stream: async function* () {},
      synthesize: async () => new Int16Array(),
      postTranscript: () => undefined,
      responseDelayMs: 0,
    });
    try {
      rooms[0]!.emit('participantConnected', { identity: 'visitor-1', name: 'Daniel', metadata: 'producer' });
      await vi.waitFor(() => expect(runner.plays('Arjun')).toBe(true));

      const renamed = pack.agenda[4]!;
      const editedAgenda = [renamed, pack.agenda[1]!];
      await runner.prepareMeeting({
        meetingId: 'meeting-1',
        attempt: 'attempt-1',
        snapshot: runnerSnapshot(pack, { meetingId: 'meeting-1', agenda: editedAgenda, version: 2 }),
      });
      await runner.markStarted({ meetingId: 'meeting-1' });

      await vi.waitFor(() => expect(runner.onCurrentAgenda(renamed.title)).toBe(true));
      expect(runner.onCurrentAgenda(bootPack.agenda[0]!.title)).toBe(false);
      expect(renamed.briefing?.length ?? 0).toBeGreaterThan(0);
    } finally {
      await runner.stop();
    }
  });
});

describe('an ended meeting on reconnect', () => {
  it('stops the conversation and never speaks the closing line on catch-up', async () => {
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
      speakerGapMs: 0,
      sentenceGapMs: 0,
    });
    try {
      const participant = { identity: 'visitor-1', name: 'Daniel', metadata: 'producer' };
      rooms[0]!.emit('participantConnected', participant);
      await vi.waitFor(() => expect(runner.plays('Arjun')).toBe(true));
      await runner.markStarted({ meetingId: 'meeting-1' });
      await vi.waitFor(() => expect(transcript.some((line) => line.startsWith('Welcome to'))).toBe(true));
      const before = transcript.length;

      runner.reconcileMeeting(
        runnerSnapshot(scenario, { meetingId: 'meeting-1', phase: 'ended', started: false, version: 3 }),
      );
      rooms[0]!.emit(
        'dataReceived',
        new TextEncoder().encode(JSON.stringify({ kind: 'text', text: 'Are we still going?' })),
        participant,
        undefined,
        CONTROL_TOPIC,
      );
      await new Promise((resolve) => setTimeout(resolve, 40));

      expect(transcript).toHaveLength(before);
      expect(log.some((line) => line.includes('ended'))).toBe(true);
    } finally {
      await runner.stop();
    }
  });

  it('does not reopen or greet an ended meeting when the guest returns to an empty room', async () => {
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
      const first = { identity: 'visitor-1', name: 'Booth Playtest', metadata: 'producer' };
      rooms[0]!.emit('participantConnected', first);
      await vi.waitFor(() => expect(runner.plays('Arjun')).toBe(true));
      await runner.markStarted({ meetingId: 'meeting-1' });
      await vi.waitFor(() => expect(transcript.filter((line) => line.startsWith('Welcome to'))).toHaveLength(1));

      rooms[0]!.emit('participantDisconnected', first);
      await new Promise((resolve) => setTimeout(resolve, 20));

      runner.reconcileMeeting(
        runnerSnapshot(scenario, { meetingId: 'meeting-1', phase: 'ended', started: false, version: 3 }),
      );

      const back = { identity: 'visitor-1', name: 'Booth Playtest', metadata: 'producer' };
      rooms[0]!.emit('participantConnected', back);
      rooms[0]!.emit(
        'dataReceived',
        new TextEncoder().encode(JSON.stringify({ kind: 'text', text: 'Are we still going?' })),
        back,
        undefined,
        CONTROL_TOPIC,
      );
      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(transcript.filter((line) => line.startsWith('Welcome back'))).toHaveLength(0);
      expect(transcript.filter((line) => line.startsWith('Welcome to'))).toHaveLength(1);
    } finally {
      await runner.stop();
    }
  });

  it('blocks typing after the meeting has ended even with a human host', async () => {
    rooms.length = 0;
    const scenario = await loadScenario('kopitiam');
    const transcript: string[] = [];
    const stream = vi.fn(async function* () {
      yield 'One more thought from the team.';
    });
    const runner = await startNpcRunner({
      scenario,
      livekitUrl: 'ws://offline.invalid',
      stream,
      synthesize: async () => new Int16Array(),
      postTranscript: (_speaker, text) => transcript.push(text),
      initialMeeting: runnerSnapshot(scenario, {
        meetingId: 'meeting-1',
        phase: 'running',
        started: true,
        hostIsHuman: true,
        version: 5,
      }),
      responseDelayMs: 0,
      speakerGapMs: 0,
      sentenceGapMs: 0,
    });
    try {
      const host = { identity: 'host-1', name: 'Mia', metadata: 'studio_manager' };
      rooms[0]!.emit('participantConnected', host);
      await vi.waitFor(() => expect(runner.plays('Arjun')).toBe(true));
      const before = transcript.length;

      runner.reconcileMeeting(
        runnerSnapshot(scenario, {
          meetingId: 'meeting-1',
          phase: 'ended',
          started: false,
          hostIsHuman: true,
          version: 6,
        }),
      );
      rooms[0]!.emit(
        'dataReceived',
        new TextEncoder().encode(JSON.stringify({ kind: 'text', text: 'Can we add one more thing?' })),
        host,
        undefined,
        CONTROL_TOPIC,
      );
      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(stream).not.toHaveBeenCalled();
      expect(transcript).toHaveLength(before);
    } finally {
      await runner.stop();
    }
  });

  it('still speaks one closing line from a live END cue after the ended snapshot', async () => {
    rooms.length = 0;
    const scenario = await loadScenario('kopitiam');
    const spoken: string[] = [];
    const runner = await startNpcRunner({
      scenario,
      livekitUrl: 'ws://offline.invalid',
      stream: async function* () {},
      synthesize: async (utterance) => {
        spoken.push(utterance.text);
        return new Int16Array();
      },
      postTranscript: () => undefined,
      responseDelayMs: 0,
      speakerGapMs: 0,
      sentenceGapMs: 0,
    });
    try {
      const participant = { identity: 'visitor-1', name: 'Daniel', metadata: 'producer' };
      rooms[0]!.emit('participantConnected', participant);
      await vi.waitFor(() => expect(runner.plays('Arjun')).toBe(true));
      await runner.markStarted({ meetingId: 'meeting-1' });

      runner.reconcileMeeting(
        runnerSnapshot(scenario, { meetingId: 'meeting-1', phase: 'ended', started: false, version: 3 }),
      );
      runner.announceClosing('That concludes our meeting. Thanks, everyone.');

      await vi.waitFor(() =>
        expect(spoken.some((line) => line.includes('That concludes our meeting'))).toBe(true),
      );
    } finally {
      await runner.stop();
    }
  });
});

describe('a facilitator moved before Start', () => {
  it('announces as the facilitator attendee, not the old host profile', async () => {
    rooms.length = 0;
    const pack = await loadScenario('kopitiam');
    const draft = defaultMeetingSetup(pack);
    const moved = {
      ...draft,
      agenda: [{ id: 'agenda-1', title: 'Opening plan', minutes: 5, ownerRoleId: 'producer' }],
      roles: draft.roles.map((role) =>
        role.id === 'lead_programmer'
          ? { ...role, facilitator: true }
          : role.id === 'studio_manager'
            ? { ...role, facilitator: false }
            : role,
      ),
    };
    const effective = meetingScenarioFromSetup(pack, moved);
    const state = runnerSnapshot(effective, { meetingId: 'meeting-1', version: 2 });
    const transcript: Array<[string, string]> = [];
    const runner = await startNpcRunner({
      scenario: pack,
      livekitUrl: 'ws://offline.invalid',
      stream: async function* () {},
      synthesize: async () => new Int16Array(),
      postTranscript: (speaker, text) => transcript.push([speaker, text]),
      initialMeeting: state,
      responseDelayMs: 0,
      speakerGapMs: 0,
      sentenceGapMs: 0,
    });
    try {
      rooms[0]!.emit('participantConnected', { identity: 'visitor-1', name: 'Daniel', metadata: 'producer' });
      await vi.waitFor(() => expect(runner.plays('Arjun')).toBe(true));
      await runner.markStarted({ meetingId: 'meeting-1', agendaIndex: 0, resumed: false });

      expect(runner.hostName()).toBe('Arjun');
      await vi.waitFor(() => expect(transcript.some(([, text]) => text.startsWith('Welcome to'))).toBe(true));
      const welcome = transcript.find(([, text]) => text.startsWith('Welcome to'))!;
      expect(welcome[0]).toBe('Arjun');
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
        const state = runnerSnapshot(scenario, { meetingId: 'meeting-1', phase: 'running', started: true });
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

  it('refuses a late older server incarnation through the real runner (E1 -> E3 -> late E2)', async () => {
    rooms.length = 0;
    const transcript: string[] = [];
    const { runner, scenario } = await openRunner(transcript);
    try {
      const e1 = { startedAt: 1_000, id: 'e1' };
      const e2 = { startedAt: 2_000, id: 'e2' };
      const e3 = { startedAt: 3_000, id: 'e3' };
      expect(
        runner.reconcileMeeting(
          runnerSnapshot(scenario, { meetingId: 'meeting-1', phase: 'running', started: true, version: { epoch: e1, seq: 10 } }),
          { currentConnection: true },
        ),
      ).toBe(true);
      expect(
        runner.reconcileMeeting(
          runnerSnapshot(scenario, { meetingId: 'meeting-3', phase: 'running', started: true, version: { epoch: e3, seq: 1 } }),
          { currentConnection: true },
        ),
      ).toBe(true);
      expect(runner.meetingId()).toBe('meeting-3');

      expect(
        runner.reconcileMeeting(
          runnerSnapshot(scenario, { meetingId: 'meeting-2', phase: 'running', started: true, version: { epoch: e2, seq: 9 } }),
          { currentConnection: true },
        ),
      ).toBe(false);
      expect(runner.meetingId()).toBe('meeting-3');
    } finally {
      await runner.stop();
    }
  });

  it('adopts a newer server incarnation through the real runner (E1 -> E2 restart)', async () => {
    rooms.length = 0;
    const transcript: string[] = [];
    const { runner, scenario } = await openRunner(transcript);
    try {
      expect(
        runner.reconcileMeeting(
          runnerSnapshot(scenario, {
            meetingId: 'meeting-1',
            phase: 'running',
            started: true,
            version: { epoch: { startedAt: 1_000, id: 'e1' }, seq: 50 },
          }),
          { currentConnection: true },
        ),
      ).toBe(true);

      expect(
        runner.reconcileMeeting(
          runnerSnapshot(scenario, {
            meetingId: 'meeting-2',
            phase: 'running',
            started: true,
            version: { epoch: { startedAt: 2_000, id: 'e2' }, seq: 1 },
          }),
          { currentConnection: true },
        ),
      ).toBe(true);
      expect(runner.meetingId()).toBe('meeting-2');
    } finally {
      await runner.stop();
    }
  });

  it('keeps the person\'s Stop against an in-flight paused:false snapshot at the same version', async () => {
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
      stopGateTimeoutMs: 60,
      responseDelayMs: 0,
      speakerGapMs: 0,
      sentenceGapMs: 0,
    });
    try {
      const participant = { identity: 'visitor-1', name: 'Booth Playtest', metadata: 'producer' };
      rooms[0]!.emit('participantConnected', participant);
      await vi.waitFor(() => expect(runner.plays('Arjun')).toBe(true));
      // Hold a snapshot first, so the Stop remembers exactly where the runner was.
      expect(
        runner.reconcileMeeting(
          runnerSnapshot(scenario, { meetingId: 'meeting-1', phase: 'running', started: true, version: 1 }),
        ),
      ).toBe(true);
      await vi.waitFor(() => expect(runner.plays('Arjun')).toBe(true));

      rooms[0]!.emit(
        'dataReceived',
        new TextEncoder().encode(JSON.stringify({ kind: 'stop' })),
        participant,
        undefined,
        CONTROL_TOPIC,
      );
      await vi.waitFor(() => expect(log.some((line) => line.includes('pressed stop'))).toBe(true));

      // A snapshot made before the server saw the Stop still says running: it must not undo it.
      runner.reconcileMeeting(
        runnerSnapshot(scenario, { meetingId: 'meeting-1', phase: 'running', started: true, paused: false, version: 1 }),
      );
      expect(log.some((line) => line.includes("kept the person's stop locally"))).toBe(true);

      // The safety net releases the local gate loudly when no newer snapshot ever arrives.
      await vi.waitFor(() =>
        expect(log.some((line) => line.includes('releasing the local stop'))).toBe(true),
      );
    } finally {
      await runner.stop();
    }
  });

  it('holds a typed line through a paused snapshot and answers it only after the resume snapshot', async () => {
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
      speakerGapMs: 0,
      sentenceGapMs: 0,
    });
    try {
      rooms[0]!.emit('participantConnected', participant);
      await vi.waitFor(() => expect(runner.plays('Arjun')).toBe(true));
      await runner.markStarted({ meetingId: 'meeting-1' });
      await vi.waitFor(() => expect(transcript.some((line) => line.startsWith('Welcome to'))).toBe(true));

      expect(
        runner.reconcileMeeting(
          runnerSnapshot(scenario, {
            meetingId: 'meeting-1', phase: 'running', started: true, paused: true, pauseKind: 'person', version: 2,
          }),
        ),
      ).toBe(true);
      rooms[0]!.emit(
        'dataReceived',
        new TextEncoder().encode(JSON.stringify({ kind: 'text', text: 'Carry on please' })),
        participant,
        undefined,
        CONTROL_TOPIC,
      );
      await vi.waitFor(() => expect(log.some((line) => line.includes('holding a typed line'))).toBe(true));
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(transcript).not.toContain('Carry on please');

      // The LiveKit resume only asks; it must not release the gate on its own.
      rooms[0]!.emit(
        'dataReceived',
        new TextEncoder().encode(JSON.stringify({ kind: 'resume' })),
        participant,
        undefined,
        CONTROL_TOPIC,
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(transcript).not.toContain('Carry on please');

      expect(
        runner.reconcileMeeting(
          runnerSnapshot(scenario, {
            meetingId: 'meeting-1', phase: 'running', started: true, paused: false, version: 3,
          }),
        ),
      ).toBe(true);
      await vi.waitFor(() => expect(transcript.some((line) => line === 'Carry on please')).toBe(true));
    } finally {
      await runner.stop();
    }
  });

  it('drops a typed line the server never resumes in time', async () => {
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
      heldTypedLineTimeoutMs: 40,
      responseDelayMs: 0,
      speakerGapMs: 0,
      sentenceGapMs: 0,
    });
    try {
      rooms[0]!.emit('participantConnected', participant);
      await vi.waitFor(() => expect(runner.plays('Arjun')).toBe(true));
      await runner.markStarted({ meetingId: 'meeting-1' });
      await vi.waitFor(() => expect(transcript.some((line) => line.startsWith('Welcome to'))).toBe(true));
      runner.reconcileMeeting(
        runnerSnapshot(scenario, {
          meetingId: 'meeting-1', phase: 'running', started: true, paused: true, pauseKind: 'person', version: 2,
        }),
      );
      rooms[0]!.emit(
        'dataReceived',
        new TextEncoder().encode(JSON.stringify({ kind: 'text', text: 'Too late now' })),
        participant,
        undefined,
        CONTROL_TOPIC,
      );
      await vi.waitFor(() => expect(log.some((line) => line.includes('did not resume within 40 ms'))).toBe(true));

      runner.reconcileMeeting(
        runnerSnapshot(scenario, {
          meetingId: 'meeting-1', phase: 'running', started: true, paused: false, version: 3,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(transcript).not.toContain('Too late now');
    } finally {
      await runner.stop();
    }
  });

  it('drops a held typed line when the meeting changes', async () => {
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
      speakerGapMs: 0,
      sentenceGapMs: 0,
    });
    try {
      rooms[0]!.emit('participantConnected', participant);
      await vi.waitFor(() => expect(runner.plays('Arjun')).toBe(true));
      await runner.markStarted({ meetingId: 'meeting-1' });
      await vi.waitFor(() => expect(transcript.some((line) => line.startsWith('Welcome to'))).toBe(true));
      runner.reconcileMeeting(
        runnerSnapshot(scenario, {
          meetingId: 'meeting-1', phase: 'running', started: true, paused: true, pauseKind: 'person', version: 2,
        }),
      );
      rooms[0]!.emit(
        'dataReceived',
        new TextEncoder().encode(JSON.stringify({ kind: 'text', text: 'For the old meeting' })),
        participant,
        undefined,
        CONTROL_TOPIC,
      );
      await vi.waitFor(() => expect(log.some((line) => line.includes('holding a typed line'))).toBe(true));

      runner.resetMeeting('meeting-2');
      expect(log.some((line) => line.includes('dropped the typed line held for the old meeting'))).toBe(true);
      expect(transcript).not.toContain('For the old meeting');
    } finally {
      await runner.stop();
    }
  });

  it('re-reads the server state while a resume is expected, and says so loudly when it stays paused', async () => {
    rooms.length = 0;
    const scenario = await loadScenario('kopitiam');
    const transcript: string[] = [];
    const log: string[] = [];
    const errors: string[] = [];
    const recheck = vi.fn();
    const runner = await startNpcRunner({
      scenario,
      livekitUrl: 'ws://offline.invalid',
      stream: async function* () {},
      synthesize: async () => new Int16Array(),
      postTranscript: (_speaker, text) => transcript.push(text),
      log: (line) => log.push(line),
      logError: (line) => errors.push(line),
      recheckMeetingState: recheck,
      resumeBackstopIntervalMs: 20,
      resumeBackstopWindowMs: 80,
      responseDelayMs: 0,
      speakerGapMs: 0,
      sentenceGapMs: 0,
    });
    try {
      rooms[0]!.emit('participantConnected', participant);
      await vi.waitFor(() => expect(runner.plays('Arjun')).toBe(true));
      await runner.markStarted({ meetingId: 'meeting-1' });
      await vi.waitFor(() => expect(transcript.some((line) => line.startsWith('Welcome to'))).toBe(true));
      runner.reconcileMeeting(
        runnerSnapshot(scenario, {
          meetingId: 'meeting-1', phase: 'running', started: true, paused: true, pauseKind: 'person', version: 2,
        }),
      );

      rooms[0]!.emit(
        'dataReceived',
        new TextEncoder().encode(JSON.stringify({ kind: 'resume' })),
        participant,
        undefined,
        CONTROL_TOPIC,
      );

      await vi.waitFor(() => expect(recheck.mock.calls.length).toBeGreaterThan(0));
      await vi.waitFor(() =>
        expect(errors.some((line) => line.includes('still paused'))).toBe(true),
      );
      const calls = recheck.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(recheck.mock.calls.length).toBe(calls);
    } finally {
      await runner.stop();
    }
  });

  it('re-reads the server state while a typed line waits, and stops once the resume arrives', async () => {
    rooms.length = 0;
    const scenario = await loadScenario('kopitiam');
    const transcript: string[] = [];
    const log: string[] = [];
    const recheck = vi.fn();
    const runner = await startNpcRunner({
      scenario,
      livekitUrl: 'ws://offline.invalid',
      stream: async function* () {},
      synthesize: async () => new Int16Array(),
      postTranscript: (_speaker, text) => transcript.push(text),
      log: (line) => log.push(line),
      recheckMeetingState: recheck,
      resumeBackstopIntervalMs: 20,
      resumeBackstopWindowMs: 500,
      responseDelayMs: 0,
      speakerGapMs: 0,
      sentenceGapMs: 0,
    });
    try {
      rooms[0]!.emit('participantConnected', participant);
      await vi.waitFor(() => expect(runner.plays('Arjun')).toBe(true));
      await runner.markStarted({ meetingId: 'meeting-1' });
      await vi.waitFor(() => expect(transcript.some((line) => line.startsWith('Welcome to'))).toBe(true));
      runner.reconcileMeeting(
        runnerSnapshot(scenario, {
          meetingId: 'meeting-1', phase: 'running', started: true, paused: true, pauseKind: 'person', version: 2,
        }),
      );
      rooms[0]!.emit(
        'dataReceived',
        new TextEncoder().encode(JSON.stringify({ kind: 'text', text: 'Carry on please' })),
        participant,
        undefined,
        CONTROL_TOPIC,
      );
      await vi.waitFor(() => expect(log.some((line) => line.includes('holding a typed line'))).toBe(true));
      await vi.waitFor(() => expect(recheck.mock.calls.length).toBeGreaterThan(0));

      runner.reconcileMeeting(
        runnerSnapshot(scenario, {
          meetingId: 'meeting-1', phase: 'running', started: true, paused: false, version: 3,
        }),
      );
      await vi.waitFor(() => expect(transcript.some((line) => line === 'Carry on please')).toBe(true));

      const calls = recheck.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(recheck.mock.calls.length).toBe(calls);
    } finally {
      await runner.stop();
    }
  });

  it('gates at once on Stop without a timeout when the snapshot already says paused', async () => {
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
      stopGateTimeoutMs: 40,
      responseDelayMs: 0,
      speakerGapMs: 0,
      sentenceGapMs: 0,
    });
    try {
      rooms[0]!.emit('participantConnected', participant);
      await vi.waitFor(() => expect(runner.plays('Arjun')).toBe(true));
      await runner.markStarted({ meetingId: 'meeting-1' });
      await vi.waitFor(() => expect(transcript.some((line) => line.startsWith('Welcome to'))).toBe(true));
      runner.reconcileMeeting(
        runnerSnapshot(scenario, {
          meetingId: 'meeting-1', phase: 'running', started: true, paused: true, pauseKind: 'person', version: 2,
        }),
      );

      rooms[0]!.emit(
        'dataReceived',
        new TextEncoder().encode(JSON.stringify({ kind: 'stop' })),
        participant,
        undefined,
        CONTROL_TOPIC,
      );
      await vi.waitFor(() => expect(log.some((line) => line.includes('pressed stop'))).toBe(true));
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(log.some((line) => line.includes('releasing the local stop'))).toBe(false);
    } finally {
      await runner.stop();
    }
  });

  it('greets once when the resume snapshot arrives before the person is back in LiveKit', async () => {
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
    });
    try {
      const first = { identity: 'visitor-1', name: 'Booth Playtest', metadata: 'producer' };
      rooms[0]!.emit('participantConnected', first);
      await vi.waitFor(() => expect(runner.plays('Arjun')).toBe(true));
      await runner.markStarted({ meetingId: 'meeting-1' });
      await vi.waitFor(() => expect(transcript.filter((line) => line.startsWith('Welcome to'))).toHaveLength(1));

      rooms[0]!.emit('participantDisconnected', first);
      runner.reconcileMeeting(
        runnerSnapshot(scenario, {
          meetingId: 'meeting-1', phase: 'running', started: true, paused: true, pauseKind: 'empty-room', version: 2,
        }),
      );
      // The server resumes before LiveKit reports the person: the greeting waits for them.
      runner.reconcileMeeting(
        runnerSnapshot(scenario, { meetingId: 'meeting-1', phase: 'running', started: true, paused: false, version: 3 }),
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(transcript.filter((line) => line.startsWith('Welcome back'))).toHaveLength(0);

      rooms[0]!.emit('participantConnected', { identity: 'visitor-1', name: 'Booth Playtest', metadata: 'producer' });
      await vi.waitFor(() => expect(transcript.filter((line) => line.startsWith('Welcome back'))).toHaveLength(1));
    } finally {
      await runner.stop();
    }
  });

  it('drops the pending welcome-back when the meeting pauses before the person returns', async () => {
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
    });
    try {
      const first = { identity: 'visitor-1', name: 'Booth Playtest', metadata: 'producer' };
      rooms[0]!.emit('participantConnected', first);
      await vi.waitFor(() => expect(runner.plays('Arjun')).toBe(true));
      await runner.markStarted({ meetingId: 'meeting-1' });
      await vi.waitFor(() => expect(transcript.filter((line) => line.startsWith('Welcome to'))).toHaveLength(1));

      rooms[0]!.emit('participantDisconnected', first);
      runner.reconcileMeeting(
        runnerSnapshot(scenario, {
          meetingId: 'meeting-1', phase: 'running', started: true, paused: true, pauseKind: 'empty-room', version: 2,
        }),
      );
      runner.reconcileMeeting(
        runnerSnapshot(scenario, { meetingId: 'meeting-1', phase: 'running', started: true, paused: false, version: 3 }),
      );
      // A person's Stop lands before they are back: there is no return to greet any more.
      runner.reconcileMeeting(
        runnerSnapshot(scenario, {
          meetingId: 'meeting-1', phase: 'running', started: true, paused: true, pauseKind: 'person', version: 4,
        }),
      );

      rooms[0]!.emit('participantConnected', { identity: 'visitor-1', name: 'Booth Playtest', metadata: 'producer' });
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(transcript.filter((line) => line.startsWith('Welcome back'))).toHaveLength(0);
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
      const state = runnerSnapshot(scenario, { meetingId: 'meeting-1', phase: 'running', started: true });
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
