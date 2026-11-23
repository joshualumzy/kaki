import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KAKI_LISTENER_IDENTITY, parseFakeSpeechMessage } from '@kaki/shared';
import { createFakeSpeaker, fakeSttFromEnv } from '../../src/npc/fakeStt';

const livekit = vi.hoisted(() => ({
  rooms: {} as Record<string, Array<{ name: string; identity: string }>>,
  sent: [] as string[],
}));

vi.mock('livekit-server-sdk', () => ({
  DataPacket_Kind: { RELIABLE: 0 },
  RoomServiceClient: class {
    async listRooms() {
      return Object.keys(livekit.rooms).map((name) => ({ name }));
    }
    async listParticipants(room: string) {
      return livekit.rooms[room] ?? [];
    }
    async sendData(room: string) {
      livekit.sent.push(room);
    }
  },
}));

describe('fakeSttFromEnv', () => {
  it('is off unless KAKI_FAKE_STT=1', () => {
    expect(fakeSttFromEnv({})).toBe(false);
    expect(fakeSttFromEnv({ KAKI_FAKE_STT: '0' })).toBe(false);
    expect(fakeSttFromEnv({ KAKI_FAKE_STT: '1', NODE_ENV: 'development' })).toBe(true);
  });

  it('refuses to start in production', () => {
    expect(() => fakeSttFromEnv({ KAKI_FAKE_STT: '1', NODE_ENV: 'production' })).toThrow(/development and tests only/);
  });
});

describe('parseFakeSpeechMessage', () => {
  it('accepts an identity and trimmed words', () => {
    expect(parseFakeSpeechMessage({ identity: ' visitor-1 ', text: '  Yes, go ahead. ' })).toEqual({
      identity: 'visitor-1',
      text: 'Yes, go ahead.',
    });
  });

  it('refuses a message without words or without a speaker', () => {
    expect(parseFakeSpeechMessage({ identity: 'visitor-1', text: '   ' })).toBeUndefined();
    expect(parseFakeSpeechMessage({ text: 'Hello' })).toBeUndefined();
    expect(parseFakeSpeechMessage('Hello')).toBeUndefined();
  });
});

describe('createFakeSpeaker', () => {
  const listener = { name: 'Kaki', identity: KAKI_LISTENER_IDENTITY };
  const robot = { name: 'Robot Visitor', identity: 'visitor-1' };

  beforeEach(() => {
    livekit.rooms = {};
    livekit.sent = [];
  });

  it('sends the line to the one room where the speaker sits with the listener', async () => {
    livekit.rooms = { lobby: [robot], practice: [robot, listener] };
    await createFakeSpeaker({}).say('robot visitor', 'Hello.');
    expect(livekit.sent).toEqual(['practice']);
  });

  it('refuses to guess when the speaker is in two meetings', async () => {
    livekit.rooms = { a: [robot, listener], b: [robot, listener] };
    await expect(createFakeSpeaker({}).say('Robot Visitor', 'Hello.')).rejects.toThrow(/more than one meeting \(a, b\)/);
    expect(livekit.sent).toEqual([]);
  });

  it('fails when no meeting has the speaker', async () => {
    livekit.rooms = { a: [listener] };
    await expect(createFakeSpeaker({}).say('Robot Visitor', 'Hello.')).rejects.toThrow(/no LiveKit room/);
  });
});
