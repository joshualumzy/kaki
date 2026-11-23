import { DataPacket_Kind, RoomServiceClient } from 'livekit-server-sdk';
import { FAKE_STT_TOPIC, KAKI_LISTENER_IDENTITY, type FakeSpeechMessage } from '@kaki/shared';
import { livekitCredentials } from '../services/livekit';

/** The one place the fake-speech flag is read, so the runner and the health check agree. */
function fakeSttRequested(env: NodeJS.ProcessEnv): boolean {
  return env.KAKI_FAKE_STT === '1';
}

/**
 * The dev-only fake speech recogniser. With `KAKI_FAKE_STT=1` the runner accepts scripted lines sent
 * by the LiveKit server on {@link FAKE_STT_TOPIC} and hands them to the same path real recognition
 * uses, so automated runs speak without a microphone. It is refused outright in production.
 */
export function fakeSttFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!fakeSttRequested(env)) return false;
  if (env.NODE_ENV === 'production') {
    throw new Error('KAKI_FAKE_STT=1 is for development and tests only; unset it in production.');
  }
  return true;
}

/**
 * Whether scripted speech is configured on, for the health check. It reports the flag truthfully
 * even in a production misconfiguration: the runner still refuses to start, but the status page
 * must not say scripted speech is off while it is set.
 */
export function fakeSttEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return fakeSttRequested(env);
}

/** LiveKit's HTTP API lives at the same host as its WebSocket URL. */
function livekitHttpUrl(url: string): string {
  return url.replace(/^ws(s?):\/\//, 'http$1://');
}

interface FakeSpeaker {
  /** Say `text` as the person whose LiveKit display name (or identity) is `name`. */
  say(name: string, text: string): Promise<void>;
}

/**
 * For scripts: say lines as a person in a meeting. It finds the room the person is in through the
 * LiveKit API and sends the line to the runner's listener. The runner must run with `KAKI_FAKE_STT=1`.
 */
export function createFakeSpeaker(env: NodeJS.ProcessEnv = process.env): FakeSpeaker {
  const { key, secret } = livekitCredentials();
  const client = new RoomServiceClient(livekitHttpUrl(env.LIVEKIT_URL || 'ws://127.0.0.1:7880'), key, secret);

  /**
   * The one room where `name` sits with the Kaki listener. Two such rooms (say, two playtests on one
   * LiveKit) is an error rather than a guess, so a line never lands in the wrong meeting.
   */
  async function findSpeakerRoom(name: string): Promise<{ room: string; identity: string }> {
    const wanted = name.trim().toLowerCase();
    const matches: Array<{ room: string; identity: string }> = [];
    for (const room of await client.listRooms()) {
      const people = await client.listParticipants(room.name);
      const listening = people.some((person) => person.identity === KAKI_LISTENER_IDENTITY);
      const person = people.find((candidate) =>
        candidate.name.trim().toLowerCase() === wanted || candidate.identity.trim().toLowerCase() === wanted);
      if (person !== undefined && listening) matches.push({ room: room.name, identity: person.identity });
    }
    if (matches.length === 0) throw new Error(`fake speech: no LiveKit room has both "${name}" and the Kaki listener`);
    if (matches.length > 1) {
      throw new Error(`fake speech: "${name}" is in more than one meeting (${matches.map((match) => match.room).join(', ')}); run one scripted meeting at a time or use a unique name`);
    }
    return matches[0]!;
  }

  return {
    async say(name, text) {
      const { room, identity } = await findSpeakerRoom(name);
      const message: FakeSpeechMessage = { identity, text };
      await client.sendData(room, new TextEncoder().encode(JSON.stringify(message)), DataPacket_Kind.RELIABLE, {
        topic: FAKE_STT_TOPIC,
        destinationIdentities: [KAKI_LISTENER_IDENTITY],
      });
    },
  };
}
