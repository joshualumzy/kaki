import { defaultMeetingSetup, FAKE_STT_TOPIC, KAKI_LISTENER_IDENTITY, meetingScenarioFromSetup, SPEECH_STATUS_TOPIC, STT_TOPIC } from '@kaki/shared';
import { describe, expect, it, vi } from 'vitest';
import { loadScenario } from '../../src/core/loadScenario';
import { openingLine } from '../../src/host/opening';
import { createMeetingSync } from '../../src/npc/meetingSync';
import { startNpcRunner } from '../../src/npc/runner';
import type { Recognizer } from '../../src/npc/utterance';
import { runnerSnapshot } from '../fixtures/runnerSnapshot';

const rooms = vi.hoisted(() => [] as Array<{ emit(event: string, ...args: unknown[]): void; connected?: boolean }>);
const published = vi.hoisted(() => [] as Array<{ topic?: string; message: unknown }>);
const audio = vi.hoisted(() => ({ frames: [] as Int16Array[] }));
const tokens = vi.hoisted(() => [] as string[]);
const startup = vi.hoisted(() => ({ hold: false, release: undefined as undefined | (() => void) }));
const prejoined = vi.hoisted(
  () =>
    [] as Array<{
      identity: string;
      name: string;
      metadata?: string;
      trackPublications: Map<string, { subscribed: boolean; track?: { kind?: number; sid?: string } }>;
    }>,
);

vi.mock('../../src/services/livekit', () => ({
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
    async connect() {
      this.connected = true;
      if (prejoined.length > 0) {
        for (const participant of prejoined) this.remoteParticipants.set(participant.identity, participant);
        prejoined.length = 0;
      }
      return undefined;
    }
    async disconnect() { this.connected = false; return undefined; }
  }
  return {
    Room,
    RoomEvent: { ParticipantConnected: 'participantConnected', ParticipantDisconnected: 'participantDisconnected', TrackSubscribed: 'trackSubscribed', DataReceived: 'dataReceived', Disconnected: 'disconnected' },
    AudioSource: class {},
    AudioStream: class {
      async *[Symbol.asyncIterator]() {
        while (audio.frames.length > 0) {
          yield { data: audio.frames.shift()!, sampleRate: 16_000 };
        }
      }
    },
    LocalAudioTrack: { createAudioTrack: () => ({}) },
    TrackPublishOptions: class {},
    TrackSource: { SOURCE_MICROPHONE: 1 },
    TrackKind: { KIND_AUDIO: 1 },
  };
});

describe('startNpcRunner task dispatch to the visitor', () => {
  it('says nothing when a task lands on the visitor: Kaki\'s pop-up points at it, not Sam', async () => {
    rooms.length = 0;
    const scenario = await loadScenario('kopitiam');
    const transcript: string[] = [];
    const runner = await startNpcRunner({
      scenario,
      livekitUrl: 'ws://offline.invalid',
      stream: async function* () {},
      synthesize: async () => new Int16Array(),
      postTranscript: (_speaker, text) => transcript.push(text),
      postTranscriptUpdate: () => undefined,
      responseDelayMs: 0,
      speakerGapMs: 0,
      sentenceGapMs: 0,
    });
    try {
      const participant = { identity: 'visitor-1', name: 'Daniel', metadata: 'operations_director' };
      rooms[0]!.emit('participantConnected', participant);
      await vi.waitFor(() => expect(runner.plays('Arjun')).toBe(true));
      await runner.markStarted();
      await vi.waitFor(() => expect(transcript.some((line) => line.startsWith('Welcome to'))).toBe(true));
      const spokenBefore = transcript.length;
      const done = vi.fn();

      runner.announce("Daniel, I've sent you a task: Send the note. Accept or decline it on your phone.", done);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // No decision is committed here, so the card claim is refused and reported as not delivered.
      expect(done).toHaveBeenCalledTimes(1);
      expect(done).toHaveBeenCalledWith(false);
      const after = transcript.slice(spokenBefore).join(' ');
      expect(after).not.toMatch(/on your (?:screen|phone)|follow-up|Send the note/i);
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
      postTranscriptUpdate: () => undefined,
      responseDelayMs: 0,
      speakerGapMs: 0,
      sentenceGapMs: 0,
    });
    try {
      const listener = rooms[0]!;
      const participant = { identity: 'visitor-1', name: 'Daniel', metadata: 'operations_director' };
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
  it('keeps a browser-recognised line out of the runner transcript and still sends it to the AI', async () => {
    rooms.length = 0;
    const scenario = await loadScenario('kopitiam');
    const transcript: Array<[string, string]> = [];
    const postHumanLine = vi.fn();
    const stream = vi.fn(async function* () {
      yield 'Sam: Noted, thanks.';
    });
    const runner = await startNpcRunner({
      scenario,
      livekitUrl: 'ws://offline.invalid',
      stream,
      synthesize: async () => new Int16Array(),
      postTranscript: (speaker, text) => transcript.push([speaker, text]),
      postTranscriptUpdate: () => undefined,
      postHumanLine,
      responseDelayMs: 0,
    });
    try {
      const listener = rooms[0]!;
      const participant = { identity: 'visitor-1', name: 'Booth Playtest', metadata: 'operations_director' };
      listener.emit('participantConnected', participant);
      await vi.waitFor(() => expect(runner.plays('Arjun')).toBe(true));
      await runner.markStarted();
      listener.emit(
        'dataReceived',
        new TextEncoder().encode(JSON.stringify({ text: 'Recognized visitor line' })),
        participant,
        undefined,
        STT_TOPIC,
      );

      await vi.waitFor(() => expect(stream).toHaveBeenCalled());
      expect(transcript.some(([, text]) => text === 'Recognized visitor line')).toBe(false);
      expect(postHumanLine).not.toHaveBeenCalled();
    } finally {
      await runner.stop();
    }
  });
});

describe('startNpcRunner fake speech recogniser (dev only)', () => {
  async function startWithFakeSpeech(fakeSpeech: boolean) {
    rooms.length = 0;
    const scenario = await loadScenario('kopitiam');
    const postHumanLine = vi.fn();
    const log: string[] = [];
    const stream = vi.fn(async function* () {
      yield 'Sam: Noted, thanks.';
    });
    const runner = await startNpcRunner({
      scenario,
      initialMeeting: runnerSnapshot(scenario, { meetingId: 'meeting-1', version: 1 }),
      livekitUrl: 'ws://offline.invalid',
      stream,
      synthesize: async () => new Int16Array(),
      postTranscript: () => undefined,
      postTranscriptUpdate: () => undefined,
      postHumanLine,
      fakeSpeech,
      log: (line) => log.push(line),
      responseDelayMs: 0,
    });
    const listener = rooms[0]!;
    const participant = { identity: 'visitor-1', name: 'Robot Visitor', metadata: 'operations_director' };
    listener.emit('participantConnected', participant);
    await vi.waitFor(() => expect(runner.plays('Arjun')).toBe(true));
    await runner.markStarted({ meetingId: 'meeting-1' });
    const say = (message: unknown, sender?: unknown): void =>
      listener.emit('dataReceived', new TextEncoder().encode(JSON.stringify(message)), sender, undefined, FAKE_STT_TOPIC);
    return { runner, postHumanLine, stream, log, participant, say };
  }

  it('treats a server-sent line as speech: the AI hears it and the transcript records it as speech', async () => {
    const { runner, postHumanLine, stream, say } = await startWithFakeSpeech(true);
    try {
      say({ identity: 'visitor-1', text: 'Let us pause delivery this weekend.' });
      await vi.waitFor(() => expect(postHumanLine).toHaveBeenCalled());
      expect(postHumanLine.mock.calls[0]![0]).toMatchObject({
        meetingId: 'meeting-1',
        participantIdentity: 'visitor-1',
        seat: 'operations_director',
        text: 'Let us pause delivery this weekend.',
        
      });
      await vi.waitFor(() => expect(stream).toHaveBeenCalled());
    } finally {
      await runner.stop();
    }
  });

  it('ignores fake speech when the recogniser is off', async () => {
    const { runner, postHumanLine, log, say } = await startWithFakeSpeech(false);
    try {
      say({ identity: 'visitor-1', text: 'This should not be heard.' });
      expect(log.some((line) => line.includes('ignored a fake-speech message'))).toBe(true);
      expect(postHumanLine).not.toHaveBeenCalled();
    } finally {
      await runner.stop();
    }
  });

  it('ignores fake speech a browser sends, so a person cannot speak as someone else', async () => {
    const { runner, postHumanLine, log, participant, say } = await startWithFakeSpeech(true);
    try {
      say({ identity: 'visitor-1', text: 'Forged from a browser.' }, participant);
      expect(log.some((line) => line.includes('ignored a fake-speech message'))).toBe(true);
      expect(postHumanLine).not.toHaveBeenCalled();
    } finally {
      await runner.stop();
    }
  });

  it('ignores fake speech for someone who is not in the room', async () => {
    const { runner, postHumanLine, log, say } = await startWithFakeSpeech(true);
    try {
      say({ identity: 'nobody', text: 'Hello?' });
      expect(log.some((line) => line.includes('ignored fake speech for nobody'))).toBe(true);
      expect(postHumanLine).not.toHaveBeenCalled();
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
    const scenario = await loadScenario('kopitiam');
    const transcript: string[] = [];
    const runner = await startNpcRunner({
      scenario,
      livekitUrl: 'ws://offline.invalid',
      stream: async function* () {},
      synthesize: async () => new Int16Array(),
      postTranscript: (_speaker, text) => transcript.push(text),
      postTranscriptUpdate: () => undefined,
      responseDelayMs: 0,
      speakerGapMs: 0,
      sentenceGapMs: 0,
    });
    try {
      const participant = { identity: 'visitor-1', name: 'Booth Playtest', metadata: 'operations_director' };
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
      initialMeeting: runnerSnapshot(scenario, { meetingId: 'meeting-1', version: 0 }),
      livekitUrl: 'ws://offline.invalid',
      stream: async function* () {},
      synthesize: async () => new Int16Array(),
      postTranscript: () => undefined,
      postTranscriptUpdate: () => undefined,
      responseDelayMs: 0,
    });
    try {
      const participant = { identity: 'visitor-1', name: 'Booth Playtest', metadata: 'operations_director' };
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

  it('moves out of the boot room on the first identity, and reports ready only after the move', async () => {
    rooms.length = 0;
    tokens.length = 0;
    startup.hold = false;
    const staleRelease = startup.release;
    const scenario = await loadScenario('kopitiam');
    const runner = await startNpcRunner({
      scenario,
      livekitUrl: 'ws://offline.invalid',
      stream: async function* () {},
      synthesize: async () => new Int16Array(),
      postTranscript: () => undefined,
      postTranscriptUpdate: () => undefined,
      responseDelayMs: 0,
    });
    try {
      const roomsBeforeMove = rooms.length;
      // Hold the new room's first character publish so the move cannot finish yet.
      startup.hold = true;
      let ready = false;
      const prepared = runner
        .prepareMeeting({
          meetingId: 'meeting-1',
          attempt: 'attempt-1',
          snapshot: runnerSnapshot(scenario, { meetingId: 'meeting-1' }),
        })
        .then(() => {
          ready = true;
        });
      // Before the fix the runner never moves out of the boot room, so no new publish is ever held.
      await vi.waitFor(() => expect(startup.release !== undefined && startup.release !== staleRelease).toBe(true));
      expect(ready).toBe(false);
      expect(rooms.length).toBeGreaterThan(roomsBeforeMove);

      startup.release?.();
      await prepared;
      expect(ready).toBe(true);
      expect(runner.meetingId()).toBe('meeting-1');
    } finally {
      startup.hold = false;
      startup.release?.();
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
      postTranscriptUpdate: () => undefined,
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
      rooms[0]!.emit('participantConnected', { identity: 'visitor-1', name: 'Booth Playtest', metadata: 'operations_director' });
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
      postTranscriptUpdate: () => undefined,
      responseDelayMs: 0,
    });
    try {
      const participant = { identity: 'visitor-1', name: 'Booth Playtest', metadata: 'operations_director' };
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
      postTranscriptUpdate: () => undefined,
      responseDelayMs: 0,
      speakerGapMs: 0,
      sentenceGapMs: 0,
    });
    try {
      const participant = { identity: 'visitor-1', name: 'Booth Playtest', metadata: 'operations_director' };
      rooms[0]!.emit('participantConnected', participant);
      await vi.waitFor(() => expect(runner.plays('Arjun')).toBe(true));
      await runner.markStarted({ meetingId: 'meeting-1' });
      await vi.waitFor(() => expect(transcript.filter((line) => line.startsWith('Welcome to'))).toHaveLength(1));

      // The service socket was down for the reset; its reconnect fetch shows a different meeting.
      const roomsBeforeMove = rooms.length;
      runner.reconcileMeeting(runnerSnapshot(scenario, { meetingId: 'meeting-2' }));
      expect(runner.meetingId()).toBe('meeting-2');
      // The runner moved to the new meeting's room; the browser follows it there.
      await vi.waitFor(() => expect(rooms.length).toBeGreaterThan(roomsBeforeMove));
      for (const room of rooms.slice(roomsBeforeMove)) room.emit('participantConnected', participant);
      await expect(runner.markStarted({ meetingId: 'meeting-1' })).rejects.toThrow(/this runner is on meeting-2/);

      await runner.prepareMeeting({ meetingId: 'meeting-2', attempt: 'attempt-2' });
      await runner.markStarted({ meetingId: 'meeting-2' });
      await vi.waitFor(() => expect(transcript.filter((line) => line.startsWith('Welcome to'))).toHaveLength(2));
      await vi.waitFor(() => expect(runner.onCurrentAgenda(scenario.agenda[0]!.title)).toBe(true));
    } finally {
      await runner.stop();
    }
  });

  it('follows a practice meeting to its new room even when it was opened with the old room name', async () => {
    rooms.length = 0;
    published.length = 0;
    const scenario = await loadScenario('kopitiam');
    const transcript: string[] = [];
    const runner = await startNpcRunner({
      scenario,
      roomName: 'kaki-demo-kopitiam-pinned',
      initialMeeting: runnerSnapshot(scenario, { meetingId: 'meeting-1' }),
      livekitUrl: 'ws://offline.invalid',
      stream: async function* () {},
      synthesize: async () => new Int16Array(),
      postTranscript: (_speaker, text) => transcript.push(text),
      postTranscriptUpdate: () => undefined,
      responseDelayMs: 0,
      speakerGapMs: 0,
      sentenceGapMs: 0,
    });
    try {
      const roomsBeforeMove = rooms.length;
      runner.reconcileMeeting(runnerSnapshot(scenario, { meetingId: 'meeting-2', version: 2 }));
      expect(runner.meetingId()).toBe('meeting-2');
      // The new identity gets a new room; the old pinned room must not keep the runner silent.
      await vi.waitFor(() => expect(rooms.length).toBeGreaterThan(roomsBeforeMove));

      const participant = { identity: 'visitor-1', name: 'Booth Playtest', metadata: 'operations_director' };
      for (const room of rooms.slice(roomsBeforeMove)) room.emit('participantConnected', participant);
      await vi.waitFor(() => expect(runner.plays('Arjun')).toBe(true));
      await runner.markStarted({ meetingId: 'meeting-2' });
      await vi.waitFor(() => expect(transcript.some((line) => line.startsWith('Welcome to'))).toBe(true));
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
      postTranscriptUpdate: () => undefined,
      log: (line) => log.push(line),
      responseDelayMs: 0,
    });
    try {
      const first = { identity: 'visitor-1', name: 'Booth Playtest', metadata: 'operations_director' };
      rooms[0]!.emit('participantConnected', first);
      await vi.waitFor(() => expect(runner.plays('Arjun')).toBe(true));
      await runner.markStarted({ meetingId: 'meeting-1' });
      await vi.waitFor(() => expect(transcript.filter((line) => line.startsWith('Welcome to'))).toHaveLength(1));
      rooms[0]!.emit('participantDisconnected', first);
      await new Promise((resolve) => setTimeout(resolve, 20));
      // The server's MEETING_RESET arrives after the grace window: no rejoin, a fresh meeting.
      runner.resetMeeting('meeting-2');
      const second = { identity: 'visitor-2', name: 'Second Visitor', metadata: 'operations_director' };
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
      postTranscriptUpdate: () => undefined,
      responseDelayMs: 0,
    });
    try {
      const first = { identity: 'visitor-1', name: 'Booth Playtest', metadata: 'operations_director' };
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

      const back = { identity: 'visitor-1', name: 'Booth Playtest', metadata: 'operations_director' };
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
      postTranscriptUpdate: () => undefined,
      responseDelayMs: 0,
    });
    try {
      const first = { identity: 'visitor-1', name: 'Booth Playtest', metadata: 'operations_director' };
      rooms[0]!.emit('participantConnected', first);
      await vi.waitFor(() => expect(runner.plays('Arjun')).toBe(true));
      rooms[0]!.emit('participantDisconnected', first);
      await new Promise((resolve) => setTimeout(resolve, 20));

      const back = { identity: 'visitor-1', name: 'Booth Playtest', metadata: 'operations_director' };
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
      postTranscriptUpdate: () => undefined,
      responseDelayMs: 0,
    });
    try {
      const first = { identity: 'visitor-1', name: 'Booth Playtest', metadata: 'operations_director' };
      rooms[0]!.emit('participantConnected', first);
      await vi.waitFor(() => expect(runner.plays('Arjun')).toBe(true));
      await runner.markStarted({ meetingId: 'meeting-1' });
      await vi.waitFor(() => expect(transcript.filter((line) => line.startsWith('Welcome to'))).toHaveLength(1));

      // The person vanished and came back between two roster polls: the server never paused.
      rooms[0]!.emit('participantDisconnected', first);
      const back = { identity: 'visitor-1', name: 'Booth Playtest', metadata: 'operations_director' };
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

describe('startNpcRunner with no AI cast', () => {
  it('runs the technical listener with zero characters and transcribes a person', async () => {
    rooms.length = 0;
    tokens.length = 0;
    audio.frames.length = 0;
    const scenario = await loadScenario('kopitiam');
    const emptyScenario = { ...scenario, npcs: [] };
    const log: string[] = [];
    const postHumanLine = vi.fn();
    const recognizer: Recognizer = {
      start: () => ({
        push: () => undefined,
        finish: async () => 'The queue is out the door.',
        cancel: () => undefined,
      }),
    };
    const runner = await startNpcRunner({
      scenario: emptyScenario,
      initialMeeting: runnerSnapshot(emptyScenario, { meetingId: 'meeting-1', cast: [], version: 1 }),
      livekitUrl: 'ws://offline.invalid',
      stream: async function* () {},
      synthesize: async () => new Int16Array(),
      postTranscript: () => undefined,
      postTranscriptUpdate: () => undefined,
      postHumanLine,
      recognizer,
      vad: { minLevel: 0.01, startMs: 40, hangoverMs: 40 },
      log: (line) => log.push(line),
      responseDelayMs: 0,
      speakerGapMs: 0,
      sentenceGapMs: 0,
    });
    try {
      expect(tokens).toEqual([KAKI_LISTENER_IDENTITY]);
      expect(log.some((line) => line.includes('0 AI characters running'))).toBe(true);

      // The listener is technical: it never becomes the person the runner talks to.
      rooms[0]!.emit('participantConnected', {
        identity: KAKI_LISTENER_IDENTITY,
        name: KAKI_LISTENER_IDENTITY,
        metadata: 'listener',
      });
      expect(runner.visitorName()).toBeUndefined();

      const participant = { identity: 'Alice', name: 'Alice', metadata: 'operations_director' };
      rooms[0]!.emit('participantConnected', participant);
      await runner.markStarted({ meetingId: 'meeting-1' });

      for (let index = 0; index < 10; index += 1) audio.frames.push(new Int16Array(640).fill(20_000));
      for (let index = 0; index < 5; index += 1) audio.frames.push(new Int16Array(640));
      rooms[0]!.emit('trackSubscribed', { kind: 1 }, undefined, participant);

      await vi.waitFor(() => expect(postHumanLine).toHaveBeenCalled());
      expect(postHumanLine.mock.calls[0]![0]).toMatchObject({
        meetingId: 'meeting-1',
        participantIdentity: 'Alice',
        seat: 'operations_director',
        text: 'The queue is out the door.',
      });
    } finally {
      await runner.stop();
    }
  });

  it('listens to a person who was already in the room when the listener connected', async () => {
    rooms.length = 0;
    tokens.length = 0;
    published.length = 0;
    prejoined.length = 0;
    audio.frames.length = 0;
    const scenario = await loadScenario('kopitiam');
    const emptyScenario = { ...scenario, npcs: [] };
    prejoined.push({
      identity: 'Alice',
      name: 'Alice',
      metadata: 'operations_director',
      trackPublications: new Map([['mic-1', { subscribed: true, track: { kind: 1, sid: 'mic-1' } }]]),
    });
    const runner = await startNpcRunner({
      scenario: emptyScenario,
      initialMeeting: runnerSnapshot(emptyScenario, { meetingId: 'meeting-1', cast: [], version: 1 }),
      livekitUrl: 'ws://offline.invalid',
      stream: async function* () {},
      synthesize: async () => new Int16Array(),
      postTranscript: () => undefined,
      postTranscriptUpdate: () => undefined,
      responseDelayMs: 0,
    });
    try {
      await vi.waitFor(() =>
        expect(
          published.some(
            (entry) =>
              entry.topic === SPEECH_STATUS_TOPIC &&
              (entry.message as { participants?: Record<string, { state?: string }> }).participants?.Alice?.state ===
                'listening',
          ),
        ).toBe(true),
      );
      expect(runner.visitorName()).toBe('Alice');
    } finally {
      await runner.stop();
    }
  });

  it('reconnects the listener after LiveKit drops it instead of exiting the runner', async () => {
    rooms.length = 0;
    tokens.length = 0;
    prejoined.length = 0;
    const scenario = await loadScenario('kopitiam');
    const emptyScenario = { ...scenario, npcs: [] };
    const log: string[] = [];
    const runner = await startNpcRunner({
      scenario: emptyScenario,
      initialMeeting: runnerSnapshot(emptyScenario, { meetingId: 'meeting-1', cast: [], version: 1 }),
      livekitUrl: 'ws://offline.invalid',
      stream: async function* () {},
      synthesize: async () => new Int16Array(),
      postTranscript: () => undefined,
      postTranscriptUpdate: () => undefined,
      log: (line) => log.push(line),
      responseDelayMs: 0,
    });
    try {
      const listener = rooms[0]!;
      expect(tokens).toEqual([KAKI_LISTENER_IDENTITY]);

      listener.emit('disconnected');

      await vi.waitFor(() => expect(tokens).toEqual([KAKI_LISTENER_IDENTITY, KAKI_LISTENER_IDENTITY]));
      await vi.waitFor(() => expect(rooms.at(-1)?.connected).toBe(true));
      await vi.waitFor(() => expect(log.some((line) => line.includes('reconnecting'))).toBe(true));
      await vi.waitFor(() =>
        expect(log.some((line) => line.includes('is listening') && line.includes('again'))).toBe(true),
      );
    } finally {
      await runner.stop();
    }
  });

  it('joins AI characters when the meeting publishes a cast after an empty boot', async () => {
    rooms.length = 0;
    tokens.length = 0;
    const scenario = await loadScenario('kopitiam');
    const emptyScenario = { ...scenario, npcs: [] };
    const runner = await startNpcRunner({
      scenario: emptyScenario,
      initialMeeting: runnerSnapshot(emptyScenario, { meetingId: 'meeting-1', cast: [], version: 1 }),
      livekitUrl: 'ws://offline.invalid',
      stream: async function* () {},
      synthesize: async () => new Int16Array(),
      postTranscript: () => undefined,
      postTranscriptUpdate: () => undefined,
      responseDelayMs: 0,
    });
    try {
      expect(tokens).toEqual([KAKI_LISTENER_IDENTITY]);
      rooms[0]!.emit('participantConnected', { identity: 'Alice', name: 'Alice', metadata: 'operations_director' });

      await runner.prepareMeeting({
        meetingId: 'meeting-1',
        attempt: 'attempt-1',
        snapshot: runnerSnapshot(scenario, { meetingId: 'meeting-1', version: 2 }),
      });

      await vi.waitFor(() => expect(runner.plays('Arjun')).toBe(true));
      expect(tokens).toContain('Arjun');
      expect(tokens).toContain('Sam');
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
      postTranscriptUpdate: () => undefined,
      responseDelayMs: 0,
      speakerGapMs: 0,
      sentenceGapMs: 0,
    });
    try {
      const listener = rooms[0]!;
      const participant = { identity: 'visitor-1', name: 'Daniel', metadata: 'operations_director' };
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
        expect(timeoutSpy.mock.calls.some((call) => call[1] === scenario.agenda[0]!.minutes * 60_000)).toBe(true);
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
      postTranscriptUpdate: () => undefined,
      initialMeeting: runnerSnapshot(scenario, { agenda: restoredOrder }),
      responseDelayMs: 0,
      speakerGapMs: 0,
      sentenceGapMs: 0,
    });
    try {
      const listener = rooms[0]!;
      await runner.markStarted({ agendaIndex: 1, resumed: true });
      const participant = { identity: 'visitor-1', name: 'Daniel', metadata: 'operations_director' };
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
      postTranscriptUpdate: () => undefined,
      initialMeeting: state,
      responseDelayMs: 0,
    });
    try {
      rooms[0]!.emit('participantConnected', { identity: 'visitor-1', name: 'Daniel', metadata: 'operations_director' });
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
      postTranscriptUpdate: () => undefined,
      responseDelayMs: 0,
      speakerGapMs: 0,
      sentenceGapMs: 0,
    });
    try {
      rooms[0]!.emit('participantConnected', { identity: 'visitor-1', name: 'Daniel', metadata: 'operations_director' });
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
      initialMeeting: runnerSnapshot(bootPack, { meetingId: 'meeting-1' }),
      livekitUrl: 'ws://offline.invalid',
      stream: async function* () {},
      synthesize: async () => new Int16Array(),
      postTranscript: () => undefined,
      postTranscriptUpdate: () => undefined,
      responseDelayMs: 0,
    });
    try {
      rooms[0]!.emit('participantConnected', { identity: 'visitor-1', name: 'Daniel', metadata: 'operations_director' });
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
  it('starts the next practice meeting fresh when the same id is live again', async () => {
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
      postTranscriptUpdate: () => undefined,
      log: (line) => log.push(line),
      responseDelayMs: 0,
      speakerGapMs: 0,
      sentenceGapMs: 0,
    });
    try {
      const participant = { identity: 'visitor-1', name: 'Daniel', metadata: 'operations_director' };
      rooms[0]!.emit('participantConnected', participant);
      await vi.waitFor(() => expect(runner.plays('Arjun')).toBe(true));
      await runner.markStarted({ meetingId: 'meeting-1' });
      await vi.waitFor(() => expect(transcript.filter((line) => line.startsWith('Welcome to'))).toHaveLength(1));

      runner.reconcileMeeting(
        runnerSnapshot(scenario, { meetingId: 'meeting-1', phase: 'ended', started: false, version: 3 }),
      );
      expect(transcript.filter((line) => line.startsWith('Welcome to'))).toHaveLength(1);

      await runner.prepareMeeting({
        meetingId: 'meeting-1',
        attempt: 'attempt-2',
        snapshot: runnerSnapshot(scenario, { meetingId: 'meeting-1', phase: 'running', started: true, version: 4 }),
      });
      await runner.markStarted({ meetingId: 'meeting-1' });

      await vi.waitFor(() => expect(transcript.filter((line) => line.startsWith('Welcome to'))).toHaveLength(2));
      expect(log.some((line) => line.includes('live again'))).toBe(true);
    } finally {
      await runner.stop();
    }
  });

  it('starts a new same-id practice meeting fresh even when the old end was never seen', async () => {
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
      postTranscriptUpdate: () => undefined,
      log: (line) => log.push(line),
      responseDelayMs: 0,
      speakerGapMs: 0,
      sentenceGapMs: 0,
    });
    try {
      const participant = { identity: 'visitor-1', name: 'Daniel', metadata: 'operations_director' };
      rooms[0]!.emit('participantConnected', participant);
      await vi.waitFor(() => expect(runner.plays('Arjun')).toBe(true));
      await runner.markStarted({ meetingId: 'meeting-1' });
      await vi.waitFor(() => expect(transcript.filter((line) => line.startsWith('Welcome to'))).toHaveLength(1));

      // The next practice meeting starts under the same id, but this runner never saw the old meeting
      // end or its reset: the prepare is the first sign of the new meeting.
      await runner.prepareMeeting({
        meetingId: 'meeting-1',
        attempt: 'attempt-2',
        snapshot: runnerSnapshot(scenario, { meetingId: 'meeting-1', phase: 'starting', started: false, version: 4 }),
      });
      await runner.markStarted({ meetingId: 'meeting-1' });
      runner.reconcileMeeting(
        runnerSnapshot(scenario, { meetingId: 'meeting-1', phase: 'running', started: true, version: 5 }),
      );

      await vi.waitFor(() => expect(transcript.filter((line) => line.startsWith('Welcome to'))).toHaveLength(2));
      expect(log.some((line) => line.includes('already ran'))).toBe(true);
    } finally {
      await runner.stop();
    }
  });

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
      postTranscriptUpdate: () => undefined,
      log: (line) => log.push(line),
      fakeSpeech: true,
      responseDelayMs: 0,
      speakerGapMs: 0,
      sentenceGapMs: 0,
    });
    try {
      const participant = { identity: 'visitor-1', name: 'Daniel', metadata: 'operations_director' };
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
        new TextEncoder().encode(JSON.stringify({ identity: 'visitor-1', text: 'Are we still going?' })),
        undefined,
        undefined,
        FAKE_STT_TOPIC,
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
      postTranscriptUpdate: () => undefined,
      fakeSpeech: true,
      responseDelayMs: 0,
      speakerGapMs: 0,
      sentenceGapMs: 0,
    });
    try {
      const first = { identity: 'visitor-1', name: 'Booth Playtest', metadata: 'operations_director' };
      rooms[0]!.emit('participantConnected', first);
      await vi.waitFor(() => expect(runner.plays('Arjun')).toBe(true));
      await runner.markStarted({ meetingId: 'meeting-1' });
      await vi.waitFor(() => expect(transcript.filter((line) => line.startsWith('Welcome to'))).toHaveLength(1));

      rooms[0]!.emit('participantDisconnected', first);
      await new Promise((resolve) => setTimeout(resolve, 20));

      runner.reconcileMeeting(
        runnerSnapshot(scenario, { meetingId: 'meeting-1', phase: 'ended', started: false, version: 3 }),
      );

      const back = { identity: 'visitor-1', name: 'Booth Playtest', metadata: 'operations_director' };
      rooms[0]!.emit('participantConnected', back);
      rooms[0]!.emit(
        'dataReceived',
        new TextEncoder().encode(JSON.stringify({ identity: 'visitor-1', text: 'Are we still going?' })),
        undefined,
        undefined,
        FAKE_STT_TOPIC,
      );
      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(transcript.filter((line) => line.startsWith('Welcome back'))).toHaveLength(0);
      expect(transcript.filter((line) => line.startsWith('Welcome to'))).toHaveLength(1);
    } finally {
      await runner.stop();
    }
  });

  it('ignores fake speech after the meeting has ended even with a human host', async () => {
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
      postTranscriptUpdate: () => undefined,
      initialMeeting: runnerSnapshot(scenario, {
        meetingId: 'meeting-1',
        phase: 'running',
        started: true,
        hostIsHuman: true,
        version: 5,
      }),
      fakeSpeech: true,
      responseDelayMs: 0,
      speakerGapMs: 0,
      sentenceGapMs: 0,
    });
    try {
      const host = { identity: 'host-1', name: 'Mia', metadata: 'general_manager' };
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
        new TextEncoder().encode(JSON.stringify({ identity: 'host-1', text: 'Can we add one more thing?' })),
        undefined,
        undefined,
        FAKE_STT_TOPIC,
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
      postTranscriptUpdate: () => undefined,
      responseDelayMs: 0,
      speakerGapMs: 0,
      sentenceGapMs: 0,
    });
    try {
      const participant = { identity: 'visitor-1', name: 'Daniel', metadata: 'operations_director' };
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
      agenda: [{ id: 'agenda-1', title: 'Opening plan', minutes: 5, ownerRoleId: 'operations_director' }],
      roles: draft.roles.map((role) =>
        role.id === 'tech_pos_lead'
          ? { ...role, facilitator: true }
          : role.id === 'general_manager'
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
      postTranscriptUpdate: () => undefined,
      initialMeeting: state,
      responseDelayMs: 0,
      speakerGapMs: 0,
      sentenceGapMs: 0,
    });
    try {
      rooms[0]!.emit('participantConnected', { identity: 'visitor-1', name: 'Daniel', metadata: 'operations_director' });
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
  const participant = { identity: 'visitor-1', name: 'Booth Playtest', metadata: 'operations_director' };

  async function openRunner(transcript: string[]) {
    const scenario = await loadScenario('kopitiam');
    const runner = await startNpcRunner({
      scenario,
      livekitUrl: 'ws://offline.invalid',
      stream: async function* () {},
      synthesize: async () => new Int16Array(),
      postTranscript: (_speaker, text) => transcript.push(text),
      postTranscriptUpdate: () => undefined,
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
        expect(timeoutSpy.mock.calls.some((call) => call[1] === scenario.agenda[0]!.minutes * 60_000)).toBe(true);

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
      postTranscriptUpdate: () => undefined,
      responseDelayMs: 0,
    });
    try {
      const first = { identity: 'visitor-1', name: 'Booth Playtest', metadata: 'operations_director' };
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

      rooms[0]!.emit('participantConnected', { identity: 'visitor-1', name: 'Booth Playtest', metadata: 'operations_director' });
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
      postTranscriptUpdate: () => undefined,
      responseDelayMs: 0,
    });
    try {
      const first = { identity: 'visitor-1', name: 'Booth Playtest', metadata: 'operations_director' };
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

      rooms[0]!.emit('participantConnected', { identity: 'visitor-1', name: 'Booth Playtest', metadata: 'operations_director' });
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

describe('per-person speech status', () => {
  const frames = (count: number, value: number): Int16Array[] =>
    Array.from({ length: count }, () => new Int16Array(640).fill(value));

  function statusMessages(): Array<{ participants: Record<string, { state: string; message?: string }>; outage?: { message: string } }> {
    return published
      .filter((entry) => entry.topic === 'kaki.speech-status')
      .map((entry) => entry.message as { participants: Record<string, { state: string; message?: string }>; outage?: { message: string } });
  }

  it('shows transcribing only for the person whose finished speech is still being recognised', async () => {
    rooms.length = 0;
    published.length = 0;
    audio.frames.length = 0;
    const scenario = await loadScenario('kopitiam');
    const sessions: Array<{ finish: () => Promise<string> }> = [];
    const runner = await startNpcRunner({
      scenario,
      initialMeeting: runnerSnapshot(scenario, { meetingId: 'meeting-1', version: 0 }),
      livekitUrl: 'ws://offline.invalid',
      stream: async function* () {},
      synthesize: async () => new Int16Array(),
      postTranscript: () => undefined,
      postTranscriptUpdate: () => undefined,
      postHumanLine: () => undefined,
      recognizer: {
        start: () => {
          const session = { finish: () => new Promise<string>(() => undefined) };
          sessions.push(session);
          return { push: () => undefined, finish: session.finish, cancel: () => undefined };
        },
      },
      vad: { minLevel: 0.01, startMs: 40, hangoverMs: 40 },
      responseDelayMs: 0,
    });
    try {
      const visitor = { identity: 'visitor-1', name: 'Booth Playtest', metadata: 'operations_director' };
      rooms[0]!.emit('participantConnected', visitor);
      await vi.waitFor(() => expect(runner.plays('Arjun')).toBe(true));
      await runner.markStarted({ meetingId: 'meeting-1' });

      audio.frames.push(...frames(30, 20_000), ...frames(10, 0));
      rooms[0]!.emit('trackSubscribed', { kind: 1 }, undefined, visitor);
      await vi.waitFor(() => expect(sessions).toHaveLength(1));
      await vi.waitFor(() =>
        expect(statusMessages().some((message) => message.participants['visitor-1']?.state === 'transcribing')).toBe(true),
      );
      const latest = statusMessages().at(-1)!;
      expect(Object.keys(latest.participants)).toEqual(['visitor-1']);
    } finally {
      await runner.stop();
    }
  });

  it('fails the speaker loudly, then raises a room-wide outage after recognition keeps failing', async () => {
    rooms.length = 0;
    published.length = 0;
    audio.frames.length = 0;
    const scenario = await loadScenario('kopitiam');
    const runner = await startNpcRunner({
      scenario,
      initialMeeting: runnerSnapshot(scenario, { meetingId: 'meeting-1', version: 0 }),
      livekitUrl: 'ws://offline.invalid',
      stream: async function* () {},
      synthesize: async () => new Int16Array(),
      postTranscript: () => undefined,
      postTranscriptUpdate: () => undefined,
      postHumanLine: () => undefined,
      recognizer: {
        start: () => ({
          push: () => undefined,
          finish: async () => { throw new Error('Azure quota exceeded'); },
          cancel: () => undefined,
        }),
      },
      vad: { minLevel: 0.01, startMs: 40, hangoverMs: 40 },
      responseDelayMs: 0,
    });
    try {
      const visitor = { identity: 'visitor-1', name: 'Booth Playtest', metadata: 'operations_director' };
      rooms[0]!.emit('participantConnected', visitor);
      await vi.waitFor(() => expect(runner.plays('Arjun')).toBe(true));
      await runner.markStarted({ meetingId: 'meeting-1' });

      audio.frames.push(...frames(10, 20_000), ...frames(10, 0));
      rooms[0]!.emit('trackSubscribed', { kind: 1 }, undefined, visitor);
      await vi.waitFor(() => {
        const latest = statusMessages().at(-1);
        expect(latest?.participants['visitor-1']?.state).toBe('failed');
      });
      expect(statusMessages().at(-1)?.outage).toBeUndefined();
      expect(statusMessages().at(-1)?.participants['visitor-1']?.message).toMatch(/Please say it again/);

      audio.frames.push(...frames(10, 20_000), ...frames(10, 0));
      rooms[0]!.emit('trackSubscribed', { kind: 1 }, undefined, visitor);
      await vi.waitFor(() => {
        const latest = statusMessages().at(-1);
        expect(latest?.participants['visitor-1']?.state).toBe('failed');
        expect(latest?.outage?.message).toMatch(/Speech recognition is not working.*Azure quota exceeded/i);
      });
    } finally {
      await runner.stop();
    }
  });
});
