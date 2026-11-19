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
  expiresAt: Date;
}

/** Everything the auth module needs from persistence. */
export interface AuthStore {
  findUserByEmail(email: string): Promise<UserRecord | undefined>;
  createUser(input: { email: string; passwordHash: string }): Promise<UserRecord>;
  createSession(session: SessionRecord): Promise<void>;
  /** Return undefined for an unknown or expired session; expired rows are dropped. */
  findSession(tokenHash: string): Promise<SessionRecord | undefined>;
  /** True when a live participant session already holds this role in this meeting. */
  hasParticipant(meetingCode: string, role: string): Promise<boolean>;
  deleteSession(tokenHash: string): Promise<void>;
  close(): Promise<void>;
}

/** An in-memory store for tests and for running without Postgres. */
export function createMemoryAuthStore(now: () => number = Date.now): AuthStore {
  const users = new Map<string, UserRecord>();
  const sessions = new Map<string, SessionRecord>();

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
    async hasParticipant(meetingCode, role) {
      for (const session of sessions.values()) {
        if (session.kind !== 'participant' || session.role !== role || session.meetingCode !== meetingCode) {
          continue;
        }
        if (session.expiresAt.getTime() > now()) return true;
      }
      return false;
    },
    async deleteSession(tokenHash) {
      sessions.delete(tokenHash);
    },
    async close() {
      users.clear();
      sessions.clear();
    },
  };
}
