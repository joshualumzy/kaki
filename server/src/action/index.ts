import { llmFromEnv } from '../llm';
import type { KakiModule } from '../modules';
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
];
