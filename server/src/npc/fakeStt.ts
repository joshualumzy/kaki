import { DataPacket_Kind, RoomServiceClient } from 'livekit-server-sdk';
import { FAKE_STT_TOPIC, KAKI_LISTENER_IDENTITY, type FakeSpeechMessage } from '@kaki/shared';
import { livekitCredentials } from '../services/livekit';

/**
 * The dev-only fake speech recogniser. With `KAKI_FAKE_STT=1` the runner accepts scripted lines sent
 * by the LiveKit server on {@link FAKE_STT_TOPIC} and hands them to the same path real recognition
 * uses, so automated runs speak without a microphone. It is refused outright in production.
 */
export function fakeSttFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.KAKI_FAKE_STT !== '1') return false;
  if (env.NODE_ENV === 'production') {
    throw new Error('KAKI_FAKE_STT=1 is for development and tests only; unset it in production.');
  }
  return true;
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

  async function find(name: string): Promise<{ room: string; identity: string }> {
    const wanted = name.trim().toLowerCase();
    for (const room of await client.listRooms()) {
      const people = await client.listParticipants(room.name);
      const listening = people.some((person) => person.identity === KAKI_LISTENER_IDENTITY);
      const person = people.find((candidate) =>
        candidate.name.trim().toLowerCase() === wanted || candidate.identity.trim().toLowerCase() === wanted);
      if (person !== undefined && listening) return { room: room.name, identity: person.identity };
    }
    throw new Error(`fake speech: no LiveKit room has both "${name}" and the Kaki listener`);
  }

  return {
    async say(name, text) {
      const { room, identity } = await find(name);
      const message: FakeSpeechMessage = { identity, text };
      await client.sendData(room, new TextEncoder().encode(JSON.stringify(message)), DataPacket_Kind.RELIABLE, {
        topic: FAKE_STT_TOPIC,
        destinationIdentities: [KAKI_LISTENER_IDENTITY],
      });
    },
  };
}
