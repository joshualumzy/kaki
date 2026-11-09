import { execFileSync } from 'node:child_process';
import type { Env } from './env';
import { COMPOSE_FILE } from './env';
import { jsonBody, jsonRequest, jsonResponse, request, waitFor } from './http';
import type { MattermostPostSeed, MattermostSeed, MattermostUserSeed } from './scenario';

const TOKEN_DESCRIPTION = 'kaki-seed';

interface MmUser {
  id: string;
  username: string;
  email: string;
  roles: string;
}

interface MmTeam {
  id: string;
  name: string;
}

interface MmChannel {
  id: string;
  name: string;
}

interface MmToken {
  id: string;
  description?: string;
  token?: string;
}

interface MmPost {
  id: string;
  message: string;
  root_id?: string;
  props?: Record<string, string>;
}

interface MmPostList {
  order: string[];
  posts: Record<string, MmPost>;
}

interface Session {
  user: MmUser;
  token: string;
}

function authHeader(token: string, json = false): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

async function mmJson<T>(
  env: Env,
  path: string,
  token: string,
  init: RequestInit = {},
  label = `Mattermost ${path}`,
): Promise<T> {
  return jsonRequest<T>(
    `${env.MATTERMOST_URL}/api/v4${path}`,
    { ...init, headers: authHeader(token, init.body !== undefined) },
    label,
  );
}

async function mmRequest(env: Env, path: string, token: string, init: RequestInit = {}): Promise<Response> {
  return request(
    `${env.MATTERMOST_URL}/api/v4${path}`,
    { ...init, headers: authHeader(token, init.body !== undefined) },
    `Mattermost ${path}`,
  );
}

async function login(env: Env, username: string): Promise<Session | undefined> {
  const response = await request(
    `${env.MATTERMOST_URL}/api/v4/users/login`,
    jsonBody('POST', { login_id: username, password: env.MATTERMOST_PASSWORD }),
    'Mattermost login',
  );
  if (response.status === 401) return undefined;
  const user = await jsonResponse<MmUser>(response, `Mattermost login for ${username}`);
  const token = response.headers.get('Token');
  if (!token) throw new Error(`Mattermost login for ${username} did not return a session token`);
  return { user, token };
}

async function signup(env: Env, user: MattermostUserSeed): Promise<MmUser> {
  const safePassword = env.MATTERMOST_PASSWORD.length >= 8 ? env.MATTERMOST_PASSWORD : 'demopassword';
  const response = await request(
    `${env.MATTERMOST_URL}/api/v4/users`,
    jsonBody('POST', {
      email: user.email,
      username: user.username,
      password: safePassword,
      first_name: user.first_name,
      last_name: user.last_name,
    }),
    `Mattermost signup for ${user.username}`,
  );
  return jsonResponse<MmUser>(response, `Mattermost signup for ${user.username}`);
}

async function findUser(env: Env, token: string, username: string): Promise<MmUser | undefined> {
  const response = await mmRequest(env, `/users/username/${encodeURIComponent(username)}`, token);
  if (response.status === 404) return undefined;
  return jsonResponse<MmUser>(response, `Mattermost user ${username}`);
}

async function ensureUser(env: Env, token: string, user: MattermostUserSeed): Promise<MmUser> {
  const existing = await findUser(env, token, user.username);
  if (existing) return existing;
  console.log(`  creating the Mattermost user ${user.username}`);
  const safePassword = env.MATTERMOST_PASSWORD.length >= 8 ? env.MATTERMOST_PASSWORD : 'demopassword';
  const response = await mmRequest(env, '/users', token, jsonBody('POST', {
    email: user.email,
    username: user.username,
    password: safePassword,
    first_name: user.first_name,
    last_name: user.last_name,
  }));
  return jsonResponse<MmUser>(response, `Mattermost create user ${user.username}`);
}

async function ensureTeam(env: Env, token: string, seed: MattermostSeed): Promise<MmTeam> {
  const response = await mmRequest(env, `/teams/name/${encodeURIComponent(seed.team.name)}`, token);
  if (response.ok) return jsonResponse<MmTeam>(response, 'Mattermost team');
  if (response.status !== 404) throw new Error(`Could not read Mattermost team "${seed.team.name}" (HTTP ${response.status})`);
  console.log(`  creating the Mattermost team ${seed.team.name}`);
  return mmJson<MmTeam>(
    env,
    '/teams',
    token,
    jsonBody('POST', { display_name: seed.team.display_name, name: seed.team.name, type: 'O' }),
    'Mattermost create team',
  );
}

async function ensureTeamMember(env: Env, token: string, teamId: string, userId: string): Promise<void> {
  const response = await mmRequest(env, `/teams/${teamId}/members/${userId}`, token);
  if (response.ok) return;
  if (response.status !== 404) throw new Error(`Could not read Mattermost team membership (HTTP ${response.status})`);
  await mmJson(
    env,
    `/teams/${teamId}/members`,
    token,
    jsonBody('POST', { team_id: teamId, user_id: userId }),
    'Mattermost add team member',
  );
}

async function ensureChannel(env: Env, token: string, teamId: string, channel: MattermostSeed['channels'][number]): Promise<MmChannel> {
  const response = await mmRequest(env, `/teams/${teamId}/channels/name/${encodeURIComponent(channel.name)}`, token);
  if (response.ok) return jsonResponse<MmChannel>(response, 'Mattermost channel');
  if (response.status !== 404) throw new Error(`Could not read Mattermost channel "${channel.name}" (HTTP ${response.status})`);
  console.log(`  creating the Mattermost channel #${channel.name}`);
  return mmJson<MmChannel>(
    env,
    '/channels',
    token,
    jsonBody('POST', {
      team_id: teamId,
      name: channel.name,
      display_name: channel.display_name,
      purpose: channel.purpose,
      type: 'O',
    }),
    'Mattermost create channel',
  );
}

async function ensureChannelMember(env: Env, token: string, channelId: string, userId: string): Promise<void> {
  const response = await mmRequest(env, `/channels/${channelId}/members/${userId}`, token);
  if (response.ok) return;
  if (response.status !== 404) throw new Error(`Could not read Mattermost channel membership (HTTP ${response.status})`);
  await mmJson(
    env,
    `/channels/${channelId}/members`,
    token,
    jsonBody('POST', { user_id: userId }),
    'Mattermost add channel member',
  );
}

async function channelPosts(env: Env, token: string, channelId: string): Promise<MmPost[]> {
  const response = await mmJson<MmPostList>(
    env,
    `/channels/${channelId}/posts?per_page=200&page=0`,
    token,
    {},
    'Mattermost channel posts',
  );
  return Object.values(response.posts);
}

async function ensurePosts(
  env: Env,
  adminToken: string,
  channels: Map<string, MmChannel>,
  sessions: Map<string, Session>,
  posts: MattermostPostSeed[],
): Promise<void> {
  const validTextsByChannel = new Map<string, Set<string>>();
  for (const post of posts) {
    let set = validTextsByChannel.get(post.channel);
    if (!set) {
      set = new Set<string>();
      validTextsByChannel.set(post.channel, set);
    }
    set.add(post.text);
  }

  const existingByChannel = new Map<string, Map<string, MmPost>>();
  for (const channel of channels.values()) {
    const postsInChannel = await channelPosts(env, adminToken, channel.id);
    const validTexts = validTextsByChannel.get(channel.name) ?? new Set<string>();
    const kept: MmPost[] = [];
    for (const post of postsInChannel) {
      if (!validTexts.has(post.message)) {
        await mmRequest(env, `/posts/${post.id}`, adminToken, { method: 'DELETE' }).catch(() => undefined);
      } else {
        kept.push(post);
      }
    }
    existingByChannel.set(channel.name, new Map(kept.map((post) => [post.message, post])));
  }

  const keyed = new Map<string, MmPost>();
  for (const post of posts) {
    const channel = channels.get(post.channel);
    if (!channel) throw new Error(`Unknown channel "${post.channel}"`);
    const session = sessions.get(post.author);
    if (!session) throw new Error(`Unknown author "${post.author}"`);
    const existing = existingByChannel.get(post.channel)?.get(post.text);

    if (existing) {
      if (existing.props?.sent_at !== post.at) {
        await mmJson(
          env,
          `/posts/${existing.id}/patch`,
          adminToken,
          jsonBody('PUT', { props: { sent_at: post.at } }),
          `Mattermost set sent_at on post in #${post.channel}`,
        );
      }
      if (post.key) keyed.set(post.key, existing);
      continue;
    }

    let rootId: string | undefined;
    if (post.replyToKey) {
      const root = keyed.get(post.replyToKey);
      if (!root) throw new Error(`Post reply references "${post.replyToKey}" before the root post was created`);
      rootId = root.id;
    }

    const created = await mmJson<MmPost>(
      env,
      '/posts',
      session.token,
      jsonBody('POST', {
        channel_id: channel.id,
        message: post.text,
        props: { sent_at: post.at },
        ...(rootId ? { root_id: rootId } : {}),
      }),
      `Mattermost create post in #${post.channel}`,
    );
    existingByChannel.get(post.channel)?.set(post.text, created);
    if (post.key) keyed.set(post.key, created);
  }
}

async function ensureToken(env: Env, session: Session): Promise<string> {
  if (env.MATTERMOST_TOKEN) {
    const response = await mmRequest(env, '/users/me', env.MATTERMOST_TOKEN);
    if (response.ok) return env.MATTERMOST_TOKEN;
  }

  const tokens = await mmJson<MmToken[]>(env, '/users/me/tokens', session.token, {}, 'Mattermost list tokens');
  for (const token of tokens.filter((entry) => entry.description === TOKEN_DESCRIPTION)) {
    await mmJson(env, `/users/me/tokens/${token.id}`, session.token, { method: 'DELETE' }, 'Mattermost delete token');
  }

  const created = await mmJson<MmToken>(
    env,
    '/users/me/tokens',
    session.token,
    jsonBody('POST', { description: TOKEN_DESCRIPTION }),
    'Mattermost create token',
  );
  if (!created.token) throw new Error('Mattermost did not return a personal access token');
  return created.token;
}

async function syncDemoPasswords(env: Env, token?: string): Promise<void> {
  try {
    execFileSync(
      'docker',
      [
        'compose',
        '-f',
        COMPOSE_FILE,
        'exec',
        '-T',
        'postgres',
        'psql',
        '-U',
        'mmuser',
        '-d',
        'mattermost',
        '-c',
        "CREATE EXTENSION IF NOT EXISTS pgcrypto; UPDATE users SET password = crypt('demo', gen_salt('bf', 10)) WHERE username IN ('demo', 'weiling', 'arjun', 'mei', 'daniel');",
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const authToken = token || env.MATTERMOST_TOKEN;
    if (authToken) {
      await fetch(`${env.MATTERMOST_URL}/api/v4/caches/invalidate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
      }).catch(() => undefined);
    }
  } catch {
    // Best-effort password sync.
  }
}

export async function seedMattermost(env: Env, seed: MattermostSeed): Promise<string> {
  await waitFor('Mattermost', async () => {
    const response = await request(`${env.MATTERMOST_URL}/api/v4/system/ping`, {}, 'Mattermost ping');
    if (!response.ok) throw new Error(`ping returned HTTP ${response.status}`);
  });

  await syncDemoPasswords(env);

  const adminSeed = seed.users.find((user) => user.username === env.MATTERMOST_ADMIN_USER);
  if (!adminSeed) throw new Error(`Mattermost admin "${env.MATTERMOST_ADMIN_USER}" is not listed in the seed users`);

  let adminSession = await login(env, adminSeed.username);
  if (!adminSession) {
    console.log(`  creating the Mattermost admin user ${adminSeed.username}`);
    await signup(env, { ...adminSeed });
    await syncDemoPasswords(env);
    adminSession = await login(env, adminSeed.username);
  }
  if (!adminSession) throw new Error(`Could not log in to Mattermost as "${adminSeed.username}"`);
  if (!adminSession.user.roles.split(/\s+/).includes('system_admin')) {
    throw new Error(`Mattermost user "${adminSeed.username}" is not a system admin; reset the stack volumes and seed again`);
  }

  const sessions = new Map<string, Session>([[adminSeed.username, adminSession]]);
  const users = new Map<string, MmUser>([[adminSeed.username, adminSession.user]]);

  const allUsers: MattermostUserSeed[] = [
    ...seed.users,
    ...(seed.users.some((u) => u.username === 'demo')
      ? []
      : [{ username: 'demo', email: 'demo@nanyangkopitiam.example', first_name: 'Demo', last_name: 'Visitor', admin: true }]),
  ];

  for (const user of allUsers) {
    if (user.username === adminSeed.username) continue;
    const created = await ensureUser(env, adminSession.token, {
      ...user,
    });
    users.set(user.username, created);
  }
  await syncDemoPasswords(env, adminSession.token);

  for (const user of allUsers) {
    if (user.username === adminSeed.username) continue;
    const session = await login(env, user.username);
    if (!session) throw new Error(`Could not log in to Mattermost as "${user.username}"`);
    sessions.set(user.username, session);
  }

  const team = await ensureTeam(env, adminSession.token, seed);
  for (const user of users.values()) {
    await ensureTeamMember(env, adminSession.token, team.id, user.id);
  }

  const channels = new Map<string, MmChannel>();
  for (const channelSeed of seed.channels) {
    const channel = await ensureChannel(env, adminSession.token, team.id, channelSeed);
    channels.set(channel.name, channel);
    for (const user of users.values()) {
      await ensureChannelMember(env, adminSession.token, channel.id, user.id);
    }
  }

  await ensurePosts(env, adminSession.token, channels, sessions, seed.posts);
  return ensureToken(env, adminSession);
}
