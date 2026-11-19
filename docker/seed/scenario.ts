import { readFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './env';

const SCENARIO_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export interface WikiPageSeed {
  path: string;
  title: string;
  description: string;
  file: string;
  content: string;
}

export interface GiteaLabelSeed {
  name: string;
  color: string;
  description?: string;
}

export interface GiteaIssueSeed {
  title: string;
  state: 'open' | 'closed';
  labels: string[];
  body: string;
  createdAt?: string;
  closedAt?: string;
  date: string;
}

export interface GiteaSeed {
  repository: { name: string; description: string; private: boolean };
  labels: GiteaLabelSeed[];
  issues: GiteaIssueSeed[];
}

export interface MattermostUserSeed {
  username: string;
  email: string;
  first_name: string;
  last_name: string;
  admin?: boolean;
}

export interface MattermostChannelSeed {
  name: string;
  display_name: string;
  purpose: string;
}

export interface MattermostPostSeed {
  key?: string;
  channel: string;
  author: string;
  at: string;
  replyToKey?: string;
  text: string;
}

export interface MattermostSeed {
  team: { name: string; display_name: string };
  users: MattermostUserSeed[];
  channels: MattermostChannelSeed[];
  posts: MattermostPostSeed[];
}

export interface MailAddressSeed {
  name: string;
  address: string;
}

export interface MailMessageSeed {
  from: MailAddressSeed;
  to: MailAddressSeed[];
  subject: string;
  date: string;
  messageId: string;
  text: string;
}

export interface ScenarioMeetingSeed {
  title: string;
  roles: Array<{ id: string; label: string }>;
  attendees: Array<{ name: string; role: string }>;
  agenda: Array<{ title: string; minutes: number; ownerRole: string }>;
}

export interface ScenarioSeed {
  name: string;
  organisation: string;
  meeting: ScenarioMeetingSeed;
  pages: WikiPageSeed[];
  gitea: GiteaSeed;
  mattermost: MattermostSeed;
  emails: MailMessageSeed[];
  postgresSchema: string;
  postgresData: string;
}

type JsonObject = Record<string, unknown>;

function fail(file: string, message: string): never {
  throw new Error(`Invalid seed file ${file}: ${message}`);
}

function objectAt(value: unknown, file: string, where: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(file, `${where} must be an object`);
  }
  return value as JsonObject;
}

function arrayAt(value: unknown, file: string, where: string): unknown[] {
  if (!Array.isArray(value)) fail(file, `${where} must be an array`);
  return value;
}

function stringAt(value: unknown, file: string, where: string): string {
  if (typeof value !== 'string' || value.trim() === '') fail(file, `${where} must be a non-empty string`);
  return value;
}

function optionalStringAt(value: unknown, file: string, where: string): string | undefined {
  if (value === undefined) return undefined;
  return stringAt(value, file, where);
}

function plainStringAt(value: unknown, file: string, where: string): string {
  if (typeof value !== 'string') fail(file, `${where} must be a string`);
  return value;
}

function positiveIntegerAt(value: unknown, file: string, where: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    fail(file, `${where} must be a whole number of minutes greater than 0`);
  }
  return value;
}

function isoDateAt(value: unknown, file: string, where: string): string {
  const text = stringAt(value, file, where);
  if (Number.isNaN(Date.parse(text))) fail(file, `${where} must be an ISO date`);
  return text;
}

function dayAt(value: unknown, file: string, where: string): string {
  const text = stringAt(value, file, where);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(text))) {
    fail(file, `${where} must be a YYYY-MM-DD date`);
  }
  return text;
}

function parseAddress(value: unknown, file: string, where: string): MailAddressSeed {
  const address = objectAt(value, file, where);
  return {
    name: stringAt(address.name, file, `${where}.name`),
    address: stringAt(address.address, file, `${where}.address`),
  };
}

export function parseWikiManifest(value: unknown, file = 'wiki/pages.json'): { pages: Array<Omit<WikiPageSeed, 'content'>> } {
  const manifest = objectAt(value, file, 'root');
  const pages = arrayAt(manifest.pages, file, 'pages').map((entry, index) => {
    const page = objectAt(entry, file, `pages[${index}]`);
    const pagePath = stringAt(page.path, file, `pages[${index}].path`);
    if (pagePath.startsWith('/') || pagePath.includes('..')) {
      fail(file, `pages[${index}].path must be a relative wiki path`);
    }
    const contentFile = stringAt(page.file, file, `pages[${index}].file`);
    if (contentFile.startsWith('/') || contentFile.includes('..')) {
      fail(file, `pages[${index}].file must be a relative file name`);
    }
    return {
      path: pagePath,
      title: stringAt(page.title, file, `pages[${index}].title`),
      description: stringAt(page.description, file, `pages[${index}].description`),
      file: contentFile,
    };
  });
  if (pages.length === 0) fail(file, 'pages must not be empty');
  return { pages };
}

export function parseGiteaSeed(value: unknown, file = 'gitea/issues.json'): GiteaSeed {
  const root = objectAt(value, file, 'root');
  const repository = objectAt(root.repository, file, 'repository');
  const labels = arrayAt(root.labels, file, 'labels').map((entry, index) => {
    const label = objectAt(entry, file, `labels[${index}]`);
    return {
      name: stringAt(label.name, file, `labels[${index}].name`),
      color: stringAt(label.color, file, `labels[${index}].color`),
      description: optionalStringAt(label.description, file, `labels[${index}].description`),
    };
  });
  const issues = arrayAt(root.issues, file, 'issues').map((entry, index) => {
    const issue = objectAt(entry, file, `issues[${index}]`);
    const state = stringAt(issue.state, file, `issues[${index}].state`);
    if (state !== 'open' && state !== 'closed') {
      fail(file, `issues[${index}].state must be "open" or "closed"`);
    }
    const createdAt = isoDateAt(issue.createdAt, file, `issues[${index}].createdAt`);
    return {
      title: stringAt(issue.title, file, `issues[${index}].title`),
      state: state as 'open' | 'closed',
      labels: arrayAt(issue.labels, file, `issues[${index}].labels`).map((label, labelIndex) =>
        stringAt(label, file, `issues[${index}].labels[${labelIndex}]`),
      ),
      body: stringAt(issue.body, file, `issues[${index}].body`),
      createdAt,
      closedAt: issue.closedAt === undefined ? undefined : isoDateAt(issue.closedAt, file, `issues[${index}].closedAt`),
      date: issue.date === undefined ? createdAt.slice(0, 10) : dayAt(issue.date, file, `issues[${index}].date`),
    };
  });
  if (issues.length === 0) fail(file, 'issues must not be empty');
  return {
    repository: {
      name: stringAt(repository.name, file, 'repository.name'),
      description: stringAt(repository.description, file, 'repository.description'),
      private: repository.private === true,
    },
    labels,
    issues,
  };
}

export function parseMattermostSeed(value: unknown, file = 'mattermost/seed.json'): MattermostSeed {
  const root = objectAt(value, file, 'root');
  const team = objectAt(root.team, file, 'team');
  const users = arrayAt(root.users, file, 'users').map((entry, index) => {
    const user = objectAt(entry, file, `users[${index}]`);
    return {
      username: stringAt(user.username, file, `users[${index}].username`),
      email: stringAt(user.email, file, `users[${index}].email`),
      first_name: stringAt(user.first_name, file, `users[${index}].first_name`),
      last_name: plainStringAt(user.last_name, file, `users[${index}].last_name`),
      admin: user.admin === true,
    };
  });
  const channels = arrayAt(root.channels, file, 'channels').map((entry, index) => {
    const channel = objectAt(entry, file, `channels[${index}]`);
    return {
      name: stringAt(channel.name, file, `channels[${index}].name`),
      display_name: stringAt(channel.display_name, file, `channels[${index}].display_name`),
      purpose: stringAt(channel.purpose, file, `channels[${index}].purpose`),
    };
  });
  const posts = arrayAt(root.posts, file, 'posts').map((entry, index) => {
    const post = objectAt(entry, file, `posts[${index}]`);
    return {
      key: optionalStringAt(post.key, file, `posts[${index}].key`),
      channel: stringAt(post.channel, file, `posts[${index}].channel`),
      author: stringAt(post.author, file, `posts[${index}].author`),
      at: isoDateAt(post.at, file, `posts[${index}].at`),
      replyToKey: optionalStringAt(post.replyToKey, file, `posts[${index}].replyToKey`),
      text: stringAt(post.text, file, `posts[${index}].text`),
    };
  });

  const channelNames = new Set(channels.map((channel) => channel.name));
  const userNames = new Set(users.map((user) => user.username));
  const keys = new Set<string>();
  for (const [index, post] of posts.entries()) {
    if (!channelNames.has(post.channel)) fail(file, `posts[${index}].channel "${post.channel}" is not defined in channels`);
    if (!userNames.has(post.author)) fail(file, `posts[${index}].author "${post.author}" is not defined in users`);
    if (post.key) {
      if (keys.has(post.key)) fail(file, `duplicate post key "${post.key}"`);
      keys.add(post.key);
    }
  }
  for (const [index, post] of posts.entries()) {
    if (post.replyToKey && !keys.has(post.replyToKey)) {
      fail(file, `posts[${index}].replyToKey "${post.replyToKey}" does not match a post key`);
    }
  }

  return {
    team: {
      name: stringAt(team.name, file, 'team.name'),
      display_name: stringAt(team.display_name, file, 'team.display_name'),
    },
    users,
    channels,
    posts,
  };
}

export function parseMailSeed(value: unknown, file = 'mail/emails.json'): MailMessageSeed[] {
  const root = objectAt(value, file, 'root');
  const emails = arrayAt(root.emails, file, 'emails').map((entry, index) => {
    const email = objectAt(entry, file, `emails[${index}]`);
    return {
      from: parseAddress(email.from, file, `emails[${index}].from`),
      to: arrayAt(email.to, file, `emails[${index}].to`).map((address, addressIndex) =>
        parseAddress(address, file, `emails[${index}].to[${addressIndex}]`),
      ),
      subject: stringAt(email.subject, file, `emails[${index}].subject`),
      date: isoDateAt(email.date, file, `emails[${index}].date`),
      messageId: stringAt(email.messageId, file, `emails[${index}].messageId`),
      text: stringAt(email.text, file, `emails[${index}].text`),
    };
  });
  if (emails.length === 0) fail(file, 'emails must not be empty');
  return emails;
}

function readJson(file: string): unknown {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`Could not read seed file ${file}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Seed file ${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}

function readText(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`Could not read seed file ${file}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}

export function parseMeetingSeed(scenario: JsonObject, file: string): ScenarioMeetingSeed {
  const roles = arrayAt(scenario.roles, file, 'roles').map((entry, index) => {
    const role = objectAt(entry, file, `roles[${index}]`);
    return {
      id: stringAt(role.id, file, `roles[${index}].id`),
      label: stringAt(role.label, file, `roles[${index}].label`),
    };
  });
  const roleIds = new Set(roles.map((role) => role.id));

  const attendees = arrayAt(scenario.attendees, file, 'attendees').map((entry, index) => {
    const attendee = objectAt(entry, file, `attendees[${index}]`);
    const role = stringAt(attendee.role, file, `attendees[${index}].role`);
    if (!roleIds.has(role)) fail(file, `attendees[${index}].role "${role}" is not defined in roles`);
    return {
      name: stringAt(attendee.name, file, `attendees[${index}].name`),
      role,
    };
  });

  const agenda = arrayAt(scenario.agenda, file, 'agenda').map((entry, index) => {
    const item = objectAt(entry, file, `agenda[${index}]`);
    const ownerRole = stringAt(item.ownerRole, file, `agenda[${index}].ownerRole`);
    if (!roleIds.has(ownerRole)) fail(file, `agenda[${index}].ownerRole "${ownerRole}" is not defined in roles`);
    return {
      title: stringAt(item.title, file, `agenda[${index}].title`),
      minutes: positiveIntegerAt(item.minutes, file, `agenda[${index}].minutes`),
      ownerRole,
    };
  });
  if (agenda.length === 0) fail(file, 'agenda must not be empty');

  return {
    title: stringAt(scenario.meetingTitle, file, 'meetingTitle'),
    roles,
    attendees,
    agenda,
  };
}

export function loadScenarioSeed(name = process.env.SCENARIO ?? 'kopitiam'): ScenarioSeed {
  if (!SCENARIO_PATTERN.test(name)) {
    throw new Error(`Invalid SCENARIO "${name}": expected a folder name such as "kopitiam"`);
  }
  const scenarioFile = path.join(REPO_ROOT, 'scenarios', name, 'scenario.json');
  const scenario = objectAt(readJson(scenarioFile), scenarioFile, 'scenario');
  const organisation = stringAt(scenario.organisation, scenarioFile, 'organisation');
  const seedDir = path.join(REPO_ROOT, 'scenarios', name, 'seed');
  const wikiFile = path.join(seedDir, 'wiki', 'pages.json');
  const wikiManifest = parseWikiManifest(readJson(wikiFile), wikiFile);
  const pages = wikiManifest.pages.map((page) => ({
    ...page,
    content: readText(path.join(seedDir, 'wiki', page.file)),
  }));

  return {
    name,
    organisation,
    meeting: parseMeetingSeed(scenario, scenarioFile),
    pages,
    gitea: parseGiteaSeed(readJson(path.join(seedDir, 'gitea', 'issues.json'))),
    mattermost: parseMattermostSeed(readJson(path.join(seedDir, 'mattermost', 'seed.json'))),
    emails: parseMailSeed(readJson(path.join(seedDir, 'mail', 'emails.json'))),
    postgresSchema: readText(path.join(seedDir, 'postgres', 'schema.sql')),
    postgresData: readText(path.join(seedDir, 'postgres', 'data.sql')),
  };
}
