import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createAuth } from '../src/auth/module';
import { hashToken } from '../src/auth/password';
import { createMemoryAuthStore } from '../src/auth/store';
import { createMemoryMeetingStore } from '../src/meeting/registry';
import { createMeetingCodeSource } from '../src/meeting/meetingCode';
import { createWikiModule } from '../src/action/wiki';
import { createTestApp, portOf, waitFor } from './helpers';

const apps: Array<Awaited<ReturnType<typeof createTestApp>>> = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

async function appWithPracticeMinutes() {
  const authStore = createMemoryAuthStore();
  const meetings = createMemoryMeetingStore();
  const meetingCode = createMeetingCodeSource('K7M2Q9');
  const auth = createAuth({ store: authStore, offeredRoles: () => [], meetingCode });
  const app = await createTestApp({
    auth,
    meetingCode,
    meetings,
    practiceModules: () => ({ modules: [createWikiModule({ minutesDelayMs: 5 })] }),
  });
  apps.push(app);
  return { app, authStore, meetings, port: portOf(app) };
}

function post(port: number, path: string, body?: unknown, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie !== undefined) headers.cookie = cookie;
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function signedInCookie(store: ReturnType<typeof createMemoryAuthStore>): Promise<string> {
  const user = await store.createGoogleUser({
    googleSub: randomUUID(),
    name: 'Ada',
    email: `${randomUUID()}@example.com`,
  });
  const token = randomUUID();
  await store.createSession({
    tokenHash: hashToken(token),
    kind: 'user',
    role: null,
    meetingCode: null,
    meetingId: null,
    displayName: 'Ada',
    userId: user.id,
    expiresAt: new Date(Date.now() + 60_000),
  });
  return `kaki_session=${token}`;
}

function endPractice(
  app: Awaited<ReturnType<typeof createTestApp>>,
  meetingId: string,
): void {
  const instance = app.registry.findPractice(meetingId);
  if (instance === undefined) throw new Error('practice instance is not loaded');
  instance.hub.publish({
    type: 'TRANSCRIPT_CHUNK',
    audience: { kind: 'all' },
    payload: {
      speaker: 'Wei Ling (Operations Director)',
      text: 'We agreed to open on Friday.',
      timestamp: new Date().toISOString(),
    },
  });
  instance.hub.publish({
    type: 'MEETING_RECORD_UPDATED',
    audience: { kind: 'all' },
    payload: {
      agendaIndex: 0,
      openQuestions: [],
      elapsedSeconds: 20,
      speakerTalkSeconds: {},
      ended: true,
    },
  });
}

describe('practice minutes history', () => {
  it('keeps a signed-in visitor’s minutes and to-dos in their own sample history', async () => {
    const { app, authStore, meetings, port } = await appWithPracticeMinutes();
    const cookie = await signedInCookie(authStore);

    const created = await post(port, '/api/practice', undefined, cookie);
    expect(created.status).toBe(200);
    const body = (await created.json()) as { meetingId: string; signedIn: boolean };
    expect(body.signedIn).toBe(true);

    const row = meetings.rows.get(body.meetingId);
    expect(row).toMatchObject({
      workspaceId: 'sample-nanyang-kopi',
      ownerUserId: expect.any(String),
      status: 'open',
    });

    endPractice(app, body.meetingId);

    const archived = await waitFor(
      () => {
        const meeting = meetings.rows.get(body.meetingId);
        return meeting?.status === 'ended' && meeting.minutes !== undefined ? meeting : undefined;
      },
      'the practice minutes in the visitor’s history',
    );
    expect(archived.minutes?.minutes).toContain('Meeting Minutes');
  });

  it('keeps a signed-out practice memory-only, with no history row', async () => {
    const { meetings, port } = await appWithPracticeMinutes();

    const created = await post(port, '/api/practice');
    expect(created.status).toBe(200);
    const body = (await created.json()) as { meetingId: string; signedIn: boolean };
    expect(body.signedIn).toBe(false);
    expect(meetings.rows.has(body.meetingId)).toBe(false);
  });
});
