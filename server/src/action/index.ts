import { llmFromEnv } from '../llm';
import type { KakiModule } from '../modules';
import { createGiteaModule, type GiteaSettings } from './gitea';

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

/** Modules that run the team's approved actions in the outside world. */
export const actionModules: KakiModule[] = [
  createGiteaModule({
    llm: llmFromEnv(),
    gitea: giteaFromEnv(),
  }),
];
