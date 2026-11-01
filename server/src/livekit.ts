import { AccessToken } from 'livekit-server-sdk';

/** `livekit-server --dev` accepts this key pair; set LIVEKIT_API_KEY / LIVEKIT_API_SECRET to override. */
function livekitCredentials(): { key: string; secret: string } {
  return {
    key: process.env.LIVEKIT_API_KEY || 'devkey',
    secret: process.env.LIVEKIT_API_SECRET || 'secret',
  };
}

/** A person joining the room: the name everyone sees, and the role they play in the meeting. */
export interface RoomJoin {
  roomName: string;
  participantName: string;
  participantRole?: string;
}

/** A join request that cannot be turned into a token, with a message for the person. */
export class JoinError extends Error {}

/**
 * Sign a room token for one person. A token's identity is the display name, so an empty name,
 * or a name an AI attendee already uses, is refused: two participants with one identity would
 * kick each other out of the room.
 */
export async function createRoomToken(join: RoomJoin, reservedNames: readonly string[] = []): Promise<string> {
  const name = join.participantName.trim();
  if (name.length === 0) throw new JoinError('participantName is required');
  if (name.length > 60) throw new JoinError('participantName is too long');
  if (reservedNames.some((reserved) => reserved.toLowerCase() === name.toLowerCase())) {
    throw new JoinError(`"${name}" is an AI attendee; pick another name`);
  }

  const { key, secret } = livekitCredentials();
  const token = new AccessToken(key, secret, {
    identity: name,
    name,
    metadata: join.participantRole,
  });
  token.addGrant({ roomJoin: true, room: join.roomName, canPublish: true, canSubscribe: true });
  return token.toJwt();
}

/** Where the browser reaches LiveKit; `undefined` lets the page use its own host on port 7880. */
export function livekitPublicUrl(): string | undefined {
  return process.env.LIVEKIT_PUBLIC_URL || undefined;
}
