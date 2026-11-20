import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';

/**
 * `livekit-server --dev` accepts this key pair; set LIVEKIT_API_KEY / LIVEKIT_API_SECRET to override.
 * With sign-in on, a missed variable must stop the server rather than let anyone forge room tokens.
 */
function livekitCredentials(): { key: string; secret: string } {
  const key = process.env.LIVEKIT_API_KEY?.trim();
  const secret = process.env.LIVEKIT_API_SECRET?.trim();
  if (process.env.KAKI_AUTH === '1') {
    if (key === undefined || key === '' || secret === undefined || secret === '') {
      throw new Error(
        'kaki livekit: KAKI_AUTH=1 needs LIVEKIT_API_KEY and LIVEKIT_API_SECRET; refusing the devkey/secret fallback.',
      );
    }
    return { key, secret };
  }
  return {
    key: key === undefined || key === '' ? 'devkey' : key,
    secret: secret === undefined || secret === '' ? 'secret' : secret,
  };
}

/** A person joining the room: the name everyone sees, and the role they play in the meeting. */
interface RoomJoin {
  roomName: string;
  participantName: string;
  participantRole?: string;
}

/** A join request that cannot be turned into a token, with a message for the person. */
export class JoinError extends Error {}

/**
 * Why this display name cannot become a room identity, or undefined when it can. Kept separate
 * from signing so a caller can refuse a bad name before it commits a meeting reset.
 */
export function joinNameProblem(participantName: string, reservedNames: readonly string[] = []): string | undefined {
  const name = participantName.trim();
  if (name.length === 0) return 'participantName is required';
  if (name.length > 60) return 'participantName is too long';
  if (reservedNames.some((reserved) => reserved.toLowerCase() === name.toLowerCase())) {
    return `"${name}" is an AI attendee; pick another name`;
  }
  return undefined;
}

/**
 * Sign a room token for one person. A token's identity is the display name, so an empty name,
 * or a name an AI attendee already uses, is refused: two participants with one identity would
 * kick each other out of the room.
 */
export async function createRoomToken(join: RoomJoin, reservedNames: readonly string[] = []): Promise<string> {
  const name = join.participantName.trim();
  const problem = joinNameProblem(name, reservedNames);
  if (problem !== undefined) throw new JoinError(problem);

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

/** The people (not AI attendees) in a room right now; `undefined` when LiveKit cannot be asked. */
export type RoomRoster = (roomName: string) => Promise<Array<{ name: string; role?: string }> | undefined>;

export function livekitRoster(): RoomRoster {
  const { key, secret } = livekitCredentials();
  const url = (process.env.LIVEKIT_URL || 'ws://127.0.0.1:7880').replace(/^ws/, 'http');
  const client = new RoomServiceClient(url, key, secret);
  return async (roomName) => {
    try {
      const participants = await client.listParticipants(roomName);
      return participants.map((p) => ({ name: p.identity, role: p.metadata || undefined }));
    } catch {
      return undefined;
    }
  };
}

/**
 * Remove the people from a meeting room that has been replaced or ended. The AI attendees are
 * left in place: the runner owns them and they carry no browser credential. A LiveKit outage is
 * logged once by the caller and never blocks the handoff, which is already safe by room identity.
 */
export async function removeRoomHumans(roomName: string, keepNames: readonly string[]): Promise<void> {
  const { key, secret } = livekitCredentials();
  const url = (process.env.LIVEKIT_URL || 'ws://127.0.0.1:7880').replace(/^ws/, 'http');
  const client = new RoomServiceClient(url, key, secret);
  const keep = new Set(keepNames.map((name) => name.trim().toLowerCase()));
  const participants = await client.listParticipants(roomName);
  await Promise.all(
    participants
      .filter((participant) => !keep.has(participant.identity.trim().toLowerCase()))
      .map((participant) => client.removeParticipant(roomName, participant.identity)),
  );
}

/** How long a seat stays reserved after a token is issued, before LiveKit is expected to show the person. */
export const ADMISSION_RESERVATION_MS = 15_000;

/** A seat handed out but not yet visible in LiveKit's roster. */
interface AdmissionReservation {
  participantName: string;
  /** The canonical role id of the seat. */
  seatId: string;
  expiresAt: number;
}

export interface SeatReservations {
  /** Live reservations, dropping expired ones and those the roster now shows. */
  active(rosterNames: readonly string[], at?: number): AdmissionReservation[];
  /** Reserve a seat for a just-admitted participant, replacing an earlier reservation with their name. */
  add(reservation: { participantName: string; seatId: string }, at?: number): void;
  /** Forget every reservation: a reset has replaced the meeting they belonged to. */
  clear(): void;
}

const sameName = (left: string, right: string): boolean => left.trim().toLowerCase() === right.trim().toLowerCase();

/**
 * In-process reservations close the gap between issuing a token and LiveKit showing the new person.
 * Without them two simultaneous joins can both see the same free seat and take it.
 */
export function createSeatReservations(
  ttlMs: number = ADMISSION_RESERVATION_MS,
  now: () => number = Date.now,
): SeatReservations {
  if (!Number.isFinite(ttlMs) || ttlMs < 0) {
    throw new Error(`The admission reservation timeout must be a non-negative number of milliseconds, got ${ttlMs}`);
  }
  let reservations: AdmissionReservation[] = [];
  return {
    active(rosterNames, at = now()) {
      reservations = reservations.filter(
        (reservation) =>
          reservation.expiresAt > at && !rosterNames.some((name) => sameName(name, reservation.participantName)),
      );
      return [...reservations];
    },
    add(reservation, at = now()) {
      reservations = reservations.filter((existing) => !sameName(existing.participantName, reservation.participantName));
      reservations.push({ ...reservation, expiresAt: at + ttlMs });
    },
    clear() {
      reservations = [];
    },
  };
}

/** Run admission tasks one at a time so a roster read and the seat reservation that follows cannot interleave. */
export function createAdmissionQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<void> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const result = tail.then(task, task);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}
