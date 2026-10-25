import { llmFromEnv } from '../llm';
import type { KakiModule } from '../modules';
import { createEmailModule, type EmailSettings } from './email';
import { createGiteaModule, type GiteaSettings } from './gitea';
import { createMattermostModule, type MattermostSettings } from './mattermost';

function requiredEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

function giteaFromEnv(): GiteaSettings | undefined {
  const url = requiredEnv('GITEA_URL');
  const token = requiredEnv('GITEA_TOKEN');
  const owner = requiredEnv('GITEA_ORG');
  const repo = requiredEnv('GITEA_REPO');
  if (url === undefined || token === undefined || owner === undefined || repo === undefined) return undefined;
  return { url, token, owner, repo };
}

function mattermostFromEnv(): MattermostSettings | undefined {
  const url = requiredEnv('MATTERMOST_URL');
  const token = requiredEnv('MATTERMOST_TOKEN');
  const team = requiredEnv('MATTERMOST_TEAM');
  const channel = requiredEnv('MATTERMOST_CHANNEL');
  if (url === undefined || token === undefined || team === undefined || channel === undefined) return undefined;
  return { url, token, team, channel };
}

function emailFromEnv(): EmailSettings | undefined {
  const smtpHost = requiredEnv('MAILPIT_SMTP_HOST');
  const rawPort = requiredEnv('MAILPIT_SMTP_PORT');
  const mailpitUrl = requiredEnv('MAILPIT_URL');
  const from = requiredEnv('EMAIL_FROM');
  if (smtpHost === undefined || rawPort === undefined || mailpitUrl === undefined || from === undefined) {
    return undefined;
  }
  const smtpPort = Number(rawPort);
  if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) {
    throw new Error(`Invalid MAILPIT_SMTP_PORT: ${rawPort}`);
  }
  return { smtpHost, smtpPort, from, mailpitUrl };
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
];
