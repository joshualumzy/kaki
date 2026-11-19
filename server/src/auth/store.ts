import { randomUUID } from 'node:crypto';

/** Who a session belongs to. */
export type SessionKind = 'host' | 'participant';

/** A host account. */
export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: Date;
}

/** A signed-in session; only the token hash is kept, never the token. */
export interface SessionRecord {
  tokenHash: string;
  kind: SessionKind;
  role: string | null;
  meetingCode: string | null;
  /** The meeting generation a seat belongs to; a host keeps host powers when it rotates, not the seat. */
  meetingId: string | null;
  expiresAt: Date;
}

/** One role's seat holder in one meeting generation, whoever they are. */
export interface SeatClaim {
  meetingId: string;
  role: string;
  /** The session token hash that holds the seat. */
  holder: string;
}

/** Everything the auth module needs from persistence. */
export interface AuthStore {
  findUserByEmail(email: string): Promise<UserRecord | undefined>;
  createUser(input: { email: string; passwordHash: string }): Promise<UserRecord>;
  createSession(session: SessionRecord): Promise<void>;
  /** Return undefined for an unknown or expired session; expired rows are dropped. */
  findSession(tokenHash: string): Promise<SessionRecord | undefined>;
  /**
   * Atomically take a seat, create the session that holds it, and retire the session it replaces.
   * Returns false when another live holder owns the seat; a failure changes nothing.
   */
  enterSeat(input: { session: SessionRecord; meetingId: string; role: string; replaces?: string }): Promise<boolean>;
  /**
   * Atomically replace a session, moving every seat it holds to the new holder. Used when a person
   * signs in again while already holding a session, so they keep their seat.
   */
  replaceSession(input: { session: SessionRecord; replaces: string }): Promise<void>;
  /** Whether this exact session still holds the role's seat in the meeting generation. */
  seatHeldBy(input: { meetingId: string; role: string; holder: string }): Promise<boolean>;
  /** Release every seat held by one session, or one meeting's seats when `meetingId` is given. */
  releaseSeats(input: { holder?: string; meetingId?: string }): Promise<void>;
  deleteSession(tokenHash: string): Promise<void>;
  close(): Promise<void>;
}

/** An in-memory store for tests and for running without Postgres. */
export function createMemoryAuthStore(now: () => number = Date.now): AuthStore {
  const users = new Map<string, UserRecord>();
  const sessions = new Map<string, SessionRecord>();
  const seats = new Map<string, SeatClaim & { expiresAt: number }>();
  const seatKey = (meetingId: string, role: string): string => `${meetingId}\u0000${role}`;

  return {
    async findUserByEmail(email) {
      return users.get(email);
    },
    async createUser({ email, passwordHash }) {
      if (users.has(email)) {
        throw new Error('A host account with that email already exists.');
      }
      const user: UserRecord = {
        id: randomUUID(),
        email,
        passwordHash,
        createdAt: new Date(now()),
      };
      users.set(email, user);
      return user;
    },
    async createSession(session) {
      sessions.set(session.tokenHash, { ...session });
    },
    async findSession(tokenHash) {
      const session = sessions.get(tokenHash);
      if (session === undefined) return undefined;
      if (session.expiresAt.getTime() <= now()) {
        sessions.delete(tokenHash);
        return undefined;
      }
      return session;
    },
    async enterSeat({ session, meetingId, role, replaces }) {
      const key = seatKey(meetingId, role);
      const existing = seats.get(key);
      const live = existing !== undefined && existing.expiresAt > now();
      if (live && existing.holder !== session.tokenHash && existing.holder !== replaces) return false;
      // No awaits before every change below, so the whole replacement is one synchronous step.
      seats.set(key, {
        meetingId,
        role,
        holder: session.tokenHash,
        expiresAt: session.expiresAt.getTime(),
      });
      sessions.set(session.tokenHash, { ...session });
      if (replaces !== undefined && replaces !== session.tokenHash) {
        for (const [seatKeyValue, seat] of seats) {
          if (seat.holder === replaces) seats.delete(seatKeyValue);
        }
        sessions.delete(replaces);
      }
      return true;
    },
    async replaceSession({ session, replaces }) {
      // No awaits before every change below, so the whole replacement is one synchronous step.
      sessions.set(session.tokenHash, { ...session });
      for (const seat of seats.values()) {
        if (seat.holder === replaces) seat.holder = session.tokenHash;
      }
      sessions.delete(replaces);
    },
    async seatHeldBy({ meetingId, role, holder }) {
      const seat = seats.get(seatKey(meetingId, role));
      return seat !== undefined && seat.holder === holder && seat.expiresAt > now();
    },
    async releaseSeats({ holder, meetingId }) {
      for (const [key, seat] of seats) {
        if (holder !== undefined && seat.holder === holder) seats.delete(key);
        else if (meetingId !== undefined && seat.meetingId === meetingId) seats.delete(key);
      }
    },
    async deleteSession(tokenHash) {
      sessions.delete(tokenHash);
    },
    async close() {
      users.clear();
      sessions.clear();
      seats.clear();
    },
  };
}
