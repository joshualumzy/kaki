import { randomUUID } from 'node:crypto';

/** Who a session belongs to. */
export type SessionKind = 'host' | 'participant' | 'user' | 'guest';

/** A product user, created by Google sign-in, or a password account made by the host CLI. */
export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string | null;
  googleSub: string | null;
  name: string | null;
  /** The Google account photo URL, when the ID token carried one. */
  picture: string | null;
  createdAt: Date;
}

/** A signed-in session; only the token hash is kept, never the token. */
export interface SessionRecord {
  tokenHash: string;
  kind: SessionKind;
  role: string | null;
  meetingCode: string | null;
  /** The meeting generation a seat or guest belongs to; a host keeps host powers when it rotates. */
  meetingId: string | null;
  /** The name a guest typed, or the Google user's display name. */
  displayName?: string | null;
  /** The product user a `user` session belongs to. */
  userId?: string | null;
  expiresAt: Date;
}

/** A workspace as stored; the sample workspace is built into code and never a row. */
export type WorkspaceKind = 'personal' | 'team';
export type WorkspaceRole = 'admin' | 'member';

export interface WorkspaceRecord {
  id: string;
  name: string;
  kind: WorkspaceKind;
  createdBy: string | null;
  createdAt: Date;
}

export interface WorkspaceMembership {
  workspace: WorkspaceRecord;
  role: WorkspaceRole;
}

export interface WorkspaceMember {
  userId: string;
  name: string | null;
  email: string;
  role: WorkspaceRole;
}

/** One role's seat holder in one meeting generation, whoever they are. */
interface SeatClaim {
  meetingId: string;
  role: string;
  /** The session token hash that holds the seat. */
  holder: string;
}

/** Everything the auth module needs from persistence. */
export interface AuthStore {
  findUserByEmail(email: string): Promise<UserRecord | undefined>;
  findUserById(id: string): Promise<UserRecord | undefined>;
  findUserByGoogleSub(googleSub: string): Promise<UserRecord | undefined>;
  createUser(input: { email: string; passwordHash: string }): Promise<UserRecord>;
  /**
   * Upsert a Google user by `google_sub`, and on first sign-in create their personal workspace
   * with them as admin in the same transaction. A second sign-in neither duplicates the user nor
   * the workspace.
   */
  createGoogleUser(input: {
    googleSub: string;
    name: string;
    email: string;
    picture?: string | null;
  }): Promise<UserRecord>;
  updateUserProfile(input: { id: string; name: string; email: string; picture?: string | null }): Promise<void>;
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

  listWorkspacesForUser(userId: string): Promise<WorkspaceMembership[]>;
  createWorkspace(input: { name: string; createdBy: string }): Promise<WorkspaceMembership>;
  getWorkspace(id: string): Promise<WorkspaceRecord | undefined>;
  getMembership(input: { workspaceId: string; userId: string }): Promise<WorkspaceRole | undefined>;
  listWorkspaceMembers(workspaceId: string): Promise<WorkspaceMember[]>;
  addWorkspaceMember(input: {
    workspaceId: string;
    userId: string;
    role: WorkspaceRole;
  }): Promise<void>;
  renameWorkspace(input: { id: string; name: string }): Promise<WorkspaceRecord | undefined>;

  close(): Promise<void>;
}

const PERSONAL_WORKSPACE_NAME = 'My workspace';

/** An in-memory store for tests and for running without Postgres. */
export function createMemoryAuthStore(now: () => number = Date.now): AuthStore {
  const usersById = new Map<string, UserRecord>();
  const userIdByEmail = new Map<string, string>();
  const userIdByGoogleSub = new Map<string, string>();
  const sessions = new Map<string, SessionRecord>();
  const seats = new Map<string, SeatClaim & { expiresAt: number }>();
  const workspaces = new Map<string, WorkspaceRecord>();
  const members = new Map<string, Map<string, WorkspaceRole>>();
  const seatKey = (meetingId: string, role: string): string => `${meetingId}\u0000${role}`;

  function rememberUser(user: UserRecord): UserRecord {
    usersById.set(user.id, user);
    userIdByEmail.set(user.email, user.id);
    if (user.googleSub !== null) userIdByGoogleSub.set(user.googleSub, user.id);
    return user;
  }

  function personalWorkspace(userId: string): WorkspaceMembership | undefined {
    for (const [workspaceId, roles] of members) {
      const role = roles.get(userId);
      if (role === undefined) continue;
      const workspace = workspaces.get(workspaceId);
      if (workspace !== undefined && workspace.kind === 'personal') return { workspace, role };
    }
    return undefined;
  }

  function insertWorkspace(
    id: string,
    name: string,
    kind: WorkspaceKind,
    createdBy: string,
    role: WorkspaceRole,
  ): WorkspaceMembership {
    const workspace: WorkspaceRecord = {
      id,
      name,
      kind,
      createdBy,
      createdAt: new Date(now()),
    };
    workspaces.set(id, workspace);
    members.set(id, new Map([[createdBy, role]]));
    return { workspace, role };
  }

  return {
    async findUserByEmail(email) {
      const id = userIdByEmail.get(email);
      return id === undefined ? undefined : usersById.get(id);
    },
    async findUserById(id) {
      return usersById.get(id);
    },
    async findUserByGoogleSub(googleSub) {
      const id = userIdByGoogleSub.get(googleSub);
      return id === undefined ? undefined : usersById.get(id);
    },
    async createUser({ email, passwordHash }) {
      if (userIdByEmail.has(email)) {
        throw new Error('A host account with that email already exists.');
      }
      const user: UserRecord = {
        id: randomUUID(),
        email,
        passwordHash,
        googleSub: null,
        name: null,
        picture: null,
        createdAt: new Date(now()),
      };
      return rememberUser(user);
    },
    async createGoogleUser({ googleSub, name, email, picture = null }) {
      const existingBySub = userIdByGoogleSub.get(googleSub);
      if (existingBySub !== undefined) {
        const existing = usersById.get(existingBySub);
        if (existing !== undefined) {
          const emailOwner = userIdByEmail.get(email);
          if (emailOwner !== undefined && emailOwner !== existing.id) {
            throw new Error('That email already belongs to another account.');
          }
          const updated: UserRecord = { ...existing, name, email, picture: picture ?? existing.picture };
          userIdByEmail.delete(existing.email);
          return rememberUser(updated);
        }
      }
      const existingByEmailId = userIdByEmail.get(email);
      if (existingByEmailId !== undefined) {
        const existing = usersById.get(existingByEmailId);
        if (existing === undefined) throw new Error('The existing user row is missing');
        if (existing.googleSub !== null && existing.googleSub !== googleSub) {
          throw new Error('That email already belongs to another Google account.');
        }
        const linked: UserRecord = { ...existing, googleSub: existing.googleSub ?? googleSub, name, picture: picture ?? existing.picture };
        rememberUser(linked);
        if (personalWorkspace(linked.id) === undefined) {
          insertWorkspace(randomUUID(), PERSONAL_WORKSPACE_NAME, 'personal', linked.id, 'admin');
        }
        return linked;
      }
      // No awaits below: the user, personal workspace and admin membership land together or not at all.
      const user: UserRecord = {
        id: randomUUID(),
        email,
        passwordHash: null,
        googleSub,
        name,
        picture,
        createdAt: new Date(now()),
      };
      rememberUser(user);
      insertWorkspace(randomUUID(), PERSONAL_WORKSPACE_NAME, 'personal', user.id, 'admin');
      return user;
    },
    async updateUserProfile({ id, name, email, picture }) {
      const existing = usersById.get(id);
      if (existing === undefined) return;
      const emailOwner = userIdByEmail.get(email);
      if (emailOwner !== undefined && emailOwner !== id) {
        throw new Error('That email already belongs to another account.');
      }
      userIdByEmail.delete(existing.email);
      rememberUser({ ...existing, name, email, ...(picture === undefined ? {} : { picture }) });
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
    async listWorkspacesForUser(userId) {
      const result: WorkspaceMembership[] = [];
      for (const [workspaceId, roles] of members) {
        const role = roles.get(userId);
        if (role === undefined) continue;
        const workspace = workspaces.get(workspaceId);
        if (workspace !== undefined) result.push({ workspace, role });
      }
      return result.sort((a, b) => a.workspace.createdAt.getTime() - b.workspace.createdAt.getTime());
    },
    async createWorkspace({ name, createdBy }) {
      return insertWorkspace(randomUUID(), name, 'team', createdBy, 'admin');
    },
    async getWorkspace(id) {
      return workspaces.get(id);
    },
    async getMembership({ workspaceId, userId }) {
      return members.get(workspaceId)?.get(userId);
    },
    async listWorkspaceMembers(workspaceId) {
      const roles = members.get(workspaceId);
      if (roles === undefined) return [];
      const result: WorkspaceMember[] = [];
      for (const [userId, role] of roles) {
        const user = usersById.get(userId);
        result.push({ userId, name: user?.name ?? null, email: user?.email ?? '', role });
      }
      return result;
    },
    async addWorkspaceMember({ workspaceId, userId, role }) {
      const roles = members.get(workspaceId);
      if (roles === undefined) throw new Error('That workspace does not exist.');
      roles.set(userId, role);
    },
    async renameWorkspace({ id, name }) {
      const workspace = workspaces.get(id);
      if (workspace === undefined) return undefined;
      const updated: WorkspaceRecord = { ...workspace, name };
      workspaces.set(id, updated);
      return updated;
    },
    async close() {
      usersById.clear();
      userIdByEmail.clear();
      userIdByGoogleSub.clear();
      sessions.clear();
      seats.clear();
      workspaces.clear();
      members.clear();
    },
  };
}
