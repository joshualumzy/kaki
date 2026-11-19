import type { ActionKind } from '@kaki/shared';
import { llmFromEnv } from '../llm';
import type { KakiModule } from '../modules';
import { createCalendarModule, type CalendarSettings } from './calendar';
import { createEmailModule, type EmailSettings } from './email';
import { createGiteaModule, type GiteaSettings } from './gitea';
import { createMattermostModule, type MattermostSettings } from './mattermost';
import { createWikiModule, type WikiSettings } from './wiki';

function requiredEnv(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[name];
  return value === undefined || value === '' ? undefined : value;
}

/** The environment variables each action kind needs before it can draft or run. */
const ACTION_ENV_REQUIREMENTS = {
  gitea_issue: ['GITEA_URL', 'GITEA_TOKEN', 'GITEA_ORG', 'GITEA_REPO'],
  mattermost_post: ['MATTERMOST_URL', 'MATTERMOST_TOKEN', 'MATTERMOST_TEAM', 'MATTERMOST_CHANNEL'],
  email: ['MAILPIT_SMTP_HOST', 'MAILPIT_SMTP_PORT', 'MAILPIT_URL', 'EMAIL_FROM'],
  wiki_page: ['WIKI_URL', 'WIKI_ADMIN_EMAIL', 'WIKI_ADMIN_PASSWORD'],
  calendar_event: ['CALDAV_URL'],
} as const satisfies Record<ActionKind, readonly string[]>;

/** Each action kind whose tool is missing configuration, with the names (never values) it needs. */
export function missingActionEnv(env: NodeJS.ProcessEnv = process.env): Partial<Record<ActionKind, string[]>> {
  const missing: Partial<Record<ActionKind, string[]>> = {};
  for (const kind of Object.keys(ACTION_ENV_REQUIREMENTS) as ActionKind[]) {
    const names = ACTION_ENV_REQUIREMENTS[kind].filter((name) => requiredEnv(name, env) === undefined);
    if (names.length > 0) missing[kind] = names;
  }
  return missing;
}

/** Log one loud startup error for every action kind whose tool is not configured. */
export function logMissingActionConfig(env: NodeJS.ProcessEnv = process.env): void {
  const entries = Object.entries(missingActionEnv(env)) as Array<[ActionKind, string[]]>;
  if (entries.length === 0) return;
  console.error(
    `kaki action: tools are not configured: ${entries
      .map(([kind, names]) => `${kind} (missing ${names.join(', ')})`)
      .join('; ')}. Tasks that need them will fail at draft time instead of drafting.`,
  );
}

/** Every value a kind's tool needs, or undefined when any of them is missing. */
function envFor<K extends ActionKind>(kind: K): Record<(typeof ACTION_ENV_REQUIREMENTS)[K][number], string> | undefined {
  const values: Record<string, string> = {};
  for (const name of ACTION_ENV_REQUIREMENTS[kind]) {
    const value = requiredEnv(name);
    if (value === undefined) return undefined;
    values[name] = value;
  }
  return values as Record<(typeof ACTION_ENV_REQUIREMENTS)[K][number], string>;
}

function giteaFromEnv(): GiteaSettings | undefined {
  const env = envFor('gitea_issue');
  if (env === undefined) return undefined;
  return { url: env.GITEA_URL, token: env.GITEA_TOKEN, owner: env.GITEA_ORG, repo: env.GITEA_REPO };
}

function mattermostFromEnv(): MattermostSettings | undefined {
  const env = envFor('mattermost_post');
  if (env === undefined) return undefined;
  return { url: env.MATTERMOST_URL, token: env.MATTERMOST_TOKEN, team: env.MATTERMOST_TEAM, channel: env.MATTERMOST_CHANNEL };
}

function emailFromEnv(): EmailSettings | undefined {
  const env = envFor('email');
  if (env === undefined) return undefined;
  const smtpPort = Number(env.MAILPIT_SMTP_PORT);
  if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) {
    throw new Error(`Invalid MAILPIT_SMTP_PORT: ${env.MAILPIT_SMTP_PORT}`);
  }
  return { smtpHost: env.MAILPIT_SMTP_HOST, smtpPort, from: env.EMAIL_FROM, mailpitUrl: env.MAILPIT_URL };
}

function wikiFromEnv(): WikiSettings | undefined {
  const env = envFor('wiki_page');
  if (env === undefined) return undefined;
  return { url: env.WIKI_URL, email: env.WIKI_ADMIN_EMAIL, password: env.WIKI_ADMIN_PASSWORD };
}

/** The calendar server and the address people use to open an event; shared with the viewer route. */
export function calendarFromEnv(): CalendarSettings | undefined {
  const env = envFor('calendar_event');
  if (env === undefined) return undefined;
  const caldavUrl = env.CALDAV_URL;
  const viewBaseUrl = requiredEnv('KAKI_PUBLIC_URL') ?? `http://127.0.0.1:${process.env.PORT ?? '3001'}`;
  return { caldavUrl, viewBaseUrl };
}

const llm = llmFromEnv();

/** Modules that run the team's approved actions in the outside world. */
export const actionModules: KakiModule[] = [
  createGiteaModule({
    llm,
    gitea: giteaFromEnv(),
  }),
  createMattermostModule({
    llm,
    mattermost: mattermostFromEnv(),
  }),
  createEmailModule({
    llm,
    email: emailFromEnv(),
  }),
  createWikiModule({
    llm,
    wiki: wikiFromEnv(),
  }),
  createCalendarModule({
    llm,
    calendar: calendarFromEnv(),
  }),
];
