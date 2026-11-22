import { isObject } from '@kaki/shared';
import { probeGitea, type GiteaSettings } from '../../action/gitea';
import { ConnectorError, type ConnectorTarget, type ToolConnector } from '../connector';

const TIMEOUT_MS = 5_000;

function baseUrl(settings: Record<string, unknown>): string {
  const url = settings.url;
  if (typeof url !== 'string' || url.trim() === '') throw new ConnectorError('Gitea needs its URL.');
  return url.replace(/\/+$/, '');
}

function nameOf(settings: Record<string, unknown>, field: 'owner' | 'repo', label: string): string {
  const value = settings[field];
  if (typeof value !== 'string' || value.trim() === '') throw new ConnectorError(`Gitea needs the ${label}.`);
  return value.trim();
}

function typed(settings: Record<string, unknown>, token: string): GiteaSettings {
  return {
    url: baseUrl(settings),
    token,
    owner: nameOf(settings, 'owner', 'organisation'),
    repo: nameOf(settings, 'repo', 'repository'),
  };
}

/** Gitea: one bot token and a repository. */
export const giteaConnector: ToolConnector = {
  kind: 'gitea',
  normalizeSettings(value) {
    if (!isObject(value)) return { ok: false, error: 'Settings must be a JSON object.' };
    try {
      return {
        ok: true,
        settings: {
          url: baseUrl(value),
          owner: nameOf(value, 'owner', 'organisation'),
          repo: nameOf(value, 'repo', 'repository'),
        },
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Gitea settings are incomplete.' };
    }
  },
  test(settings, token) {
    return probeGitea(typed(settings, token));
  },
  async listTargets(settings, token): Promise<ConnectorTarget[]> {
    const base = baseUrl(settings);
    let response: Response;
    try {
      response = await fetch(`${base}/api/v1/user/repos?limit=50`, {
        headers: { authorization: `token ${token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new ConnectorError('Gitea is not answering. Check that it is running.');
    }
    if (!response.ok) throw new ConnectorError(`Gitea returned HTTP ${response.status}.`);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ConnectorError('Gitea answered with something that is not JSON.');
    }
    if (!Array.isArray(body)) throw new ConnectorError('Gitea answered without a repository list.');
    return body.flatMap((repo) => {
      if (!isObject(repo)) return [];
      const fullName = typeof repo.full_name === 'string' ? repo.full_name : '';
      if (fullName === '') return [];
      return [{ id: fullName, label: fullName }];
    });
  },
  targetRef(settings) {
    try {
      return `${nameOf(settings, 'owner', 'organisation')}/${nameOf(settings, 'repo', 'repository')}`;
    } catch {
      return undefined;
    }
  },
};
