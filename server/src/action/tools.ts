import type { ActionKind } from '@kaki/shared';
import { probeCalendar, type CalendarSettings } from './calendar';
import { probeEmail, type EmailSettings, type EmailTransportFactory } from './email';
import { probeGitea, type GiteaSettings } from './gitea';
import { probeMattermost, type MattermostSettings } from './mattermost';
import { DEFAULT_PROBE_TIMEOUT_MS, probeFailed, type ToolProbeResult } from './probe';
import { publicToolUrls } from './publicToolUrls';
import { probeWiki, type WikiSettings } from './wiki';

const ACTION_TOOL_KINDS = [
  'calendar_event',
  'email',
  'gitea_issue',
  'mattermost_post',
  'wiki_page',
] as const satisfies readonly ActionKind[];

const ACTION_ENV_REQUIREMENTS = {
  gitea_issue: ['GITEA_URL', 'GITEA_TOKEN', 'GITEA_ORG', 'GITEA_REPO'],
  mattermost_post: ['MATTERMOST_URL', 'MATTERMOST_TOKEN', 'MATTERMOST_TEAM', 'MATTERMOST_CHANNEL'],
  email: ['MAILPIT_SMTP_HOST', 'MAILPIT_SMTP_PORT', 'MAILPIT_URL', 'EMAIL_FROM'],
  wiki_page: ['WIKI_URL', 'WIKI_ADMIN_EMAIL', 'WIKI_ADMIN_PASSWORD'],
  calendar_event: ['CALDAV_URL'],
} as const satisfies Record<ActionKind, readonly string[]>;

const ACTION_TOOL_LABELS = {
  calendar_event: 'Team calendar',
  email: 'Email',
  gitea_issue: 'Gitea issues',
  mattermost_post: 'Mattermost',
  wiki_page: 'Team wiki',
} as const satisfies Record<ActionKind, string>;

interface ActionToolStatus {
  kind: ActionKind;
  label: string;
  configured: boolean;
  missing: string[];
}

/** Overrides for action tool handling; tests pass a fake environment, fetch or mail transport. */
export interface ActionToolOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  emailTransport?: EmailTransportFactory;
}

function requiredEnv(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const value = env[name];
  return value === undefined || value === '' ? undefined : value;
}

function emailPort(value: string | undefined): number | undefined {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined;
}

function missingNames(kind: ActionKind, env: NodeJS.ProcessEnv): string[] {
  const names = ACTION_ENV_REQUIREMENTS[kind].filter((name) => requiredEnv(name, env) === undefined);
  if (kind === 'email' && names.length === 0 && emailPort(env.MAILPIT_SMTP_PORT) === undefined) {
    names.push('MAILPIT_SMTP_PORT');
  }
  return names;
}

function envFor<K extends ActionKind>(
  kind: K,
  env: NodeJS.ProcessEnv,
): Record<(typeof ACTION_ENV_REQUIREMENTS)[K][number], string> | undefined {
  const values: Record<string, string> = {};
  for (const name of ACTION_ENV_REQUIREMENTS[kind]) {
    const value = requiredEnv(name, env);
    if (value === undefined) return undefined;
    values[name] = value;
  }
  return values as Record<(typeof ACTION_ENV_REQUIREMENTS)[K][number], string>;
}

/** The Gitea settings from the environment, or undefined when a required value is missing. */
export function giteaFromEnv(env: NodeJS.ProcessEnv = process.env): GiteaSettings | undefined {
  const values = envFor('gitea_issue', env);
  if (values === undefined) return undefined;
  return {
    url: values.GITEA_URL,
    token: values.GITEA_TOKEN,
    owner: values.GITEA_ORG,
    repo: values.GITEA_REPO,
    publicUrl: publicToolUrls(env).gitea,
  };
}

/** The Mattermost settings from the environment, or undefined when a required value is missing. */
export function mattermostFromEnv(env: NodeJS.ProcessEnv = process.env): MattermostSettings | undefined {
  const values = envFor('mattermost_post', env);
  if (values === undefined) return undefined;
  return {
    url: values.MATTERMOST_URL,
    token: values.MATTERMOST_TOKEN,
    team: values.MATTERMOST_TEAM,
    channel: values.MATTERMOST_CHANNEL,
    publicUrl: publicToolUrls(env).mattermost,
  };
}

/** The mail settings from the environment, or undefined when a required value or valid port is missing. */
export function emailFromEnv(env: NodeJS.ProcessEnv = process.env): EmailSettings | undefined {
  const values = envFor('email', env);
  if (values === undefined) return undefined;
  const smtpPort = emailPort(values.MAILPIT_SMTP_PORT);
  if (smtpPort === undefined) return undefined;
  return {
    smtpHost: values.MAILPIT_SMTP_HOST,
    smtpPort,
    from: values.EMAIL_FROM,
    mailpitUrl: values.MAILPIT_URL,
    publicUrl: publicToolUrls(env).email,
  };
}

/** The wiki settings from the environment, or undefined when a required value is missing. */
export function wikiFromEnv(env: NodeJS.ProcessEnv = process.env): WikiSettings | undefined {
  const values = envFor('wiki_page', env);
  if (values === undefined) return undefined;
  return {
    url: values.WIKI_URL,
    email: values.WIKI_ADMIN_EMAIL,
    password: values.WIKI_ADMIN_PASSWORD,
    publicUrl: publicToolUrls(env).wiki,
  };
}

/** The calendar settings from the environment, with the public view URL, or undefined without a CalDAV address. */
export function calendarFromEnv(env: NodeJS.ProcessEnv = process.env): CalendarSettings | undefined {
  const values = envFor('calendar_event', env);
  if (values === undefined) return undefined;
  return { caldavUrl: values.CALDAV_URL, viewBaseUrl: publicToolUrls(env).calendar };
}

/** The required setting names each unconfigured action tool is missing, keyed by kind. */
export function missingActionEnv(env: NodeJS.ProcessEnv = process.env): Partial<Record<ActionKind, string[]>> {
  const missing: Partial<Record<ActionKind, string[]>> = {};
  for (const kind of ACTION_TOOL_KINDS) {
    const names = missingNames(kind, env);
    if (names.length > 0) missing[kind] = names;
  }
  return missing;
}

/** Every action tool with its label and whether its settings are complete. */
export function actionToolStatus(env: NodeJS.ProcessEnv = process.env): ActionToolStatus[] {
  return ACTION_TOOL_KINDS.map((kind) => {
    const missing = missingNames(kind, env);
    return { kind, label: ACTION_TOOL_LABELS[kind], configured: missing.length === 0, missing };
  });
}

/** True when the value names an action tool kind. */
export function isActionToolKind(value: string): value is ActionKind {
  return (ACTION_TOOL_KINDS as readonly string[]).includes(value);
}

/** Checks one action tool with its saved settings, without drafting anything. */
export async function probeActionTool(
  kind: ActionKind,
  {
    env = process.env,
    fetchImpl = fetch,
    timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
    emailTransport,
  }: ActionToolOptions = {},
): Promise<ToolProbeResult> {
  const missing = missingNames(kind, env);
  if (missing.length > 0) {
    return probeFailed(
      'not configured',
      `${ACTION_TOOL_LABELS[kind]} is not configured: set ${missing.join(', ')}.`,
    );
  }

  switch (kind) {
    case 'calendar_event': {
      const settings = calendarFromEnv(env);
      return settings === undefined
        ? probeFailed('not configured', 'Team calendar is not configured: set CALDAV_URL.')
        : probeCalendar(settings, fetchImpl, timeoutMs);
    }
    case 'email': {
      const settings = emailFromEnv(env);
      return settings === undefined
        ? probeFailed('not configured', 'Email is not configured: set MAILPIT_SMTP_HOST, MAILPIT_SMTP_PORT, MAILPIT_URL and EMAIL_FROM.')
        : probeEmail(settings, { fetchImpl, timeoutMs, createTransport: emailTransport });
    }
    case 'gitea_issue': {
      const settings = giteaFromEnv(env);
      return settings === undefined
        ? probeFailed('not configured', 'Gitea issues are not configured: set GITEA_URL, GITEA_TOKEN, GITEA_ORG and GITEA_REPO.')
        : probeGitea(settings, fetchImpl, timeoutMs);
    }
    case 'mattermost_post': {
      const settings = mattermostFromEnv(env);
      return settings === undefined
        ? probeFailed('not configured', 'Mattermost is not configured: set MATTERMOST_URL, MATTERMOST_TOKEN, MATTERMOST_TEAM and MATTERMOST_CHANNEL.')
        : probeMattermost(settings, fetchImpl, timeoutMs);
    }
    case 'wiki_page': {
      const settings = wikiFromEnv(env);
      return settings === undefined
        ? probeFailed('not configured', 'Team wiki is not configured: set WIKI_URL, WIKI_ADMIN_EMAIL and WIKI_ADMIN_PASSWORD.')
        : probeWiki(settings, fetchImpl, timeoutMs);
    }
  }
}
