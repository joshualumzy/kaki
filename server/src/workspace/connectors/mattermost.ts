import { isObject } from '@kaki/shared';
import { probeMattermost, type MattermostSettings } from '../../action/mattermost';
import { ConnectorError, type ConnectorTarget, type ToolConnector } from '../connector';

const TIMEOUT_MS = 5_000;

function baseUrl(settings: Record<string, unknown>): string {
  const url = settings.url;
  if (typeof url !== 'string' || url.trim() === '') throw new ConnectorError('Mattermost needs its URL.');
  return url.replace(/\/+$/, '');
}

function teamName(settings: Record<string, unknown>): string {
  const team = settings.team;
  if (typeof team !== 'string' || team.trim() === '') throw new ConnectorError('Mattermost needs its team.');
  return team.trim();
}

function channelName(settings: Record<string, unknown>): string {
  const channel = settings.channel;
  return typeof channel === 'string' ? channel.trim() : '';
}

function typed(settings: Record<string, unknown>, token: string): MattermostSettings {
  return { url: baseUrl(settings), token, team: teamName(settings), channel: channelName(settings) };
}

async function requestJson(url: string, token: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ConnectorError('Mattermost is not answering. Check that it is running.');
  }
  if (!response.ok) {
    throw new ConnectorError(`Mattermost returned HTTP ${response.status}.`);
  }
  try {
    return await response.json();
  } catch {
    throw new ConnectorError('Mattermost answered with something that is not JSON.');
  }
}

/** Mattermost: one bot token, a team and a channel. */
export const mattermostConnector: ToolConnector = {
  kind: 'mattermost',
  normalizeSettings(value) {
    if (!isObject(value)) return { ok: false, error: 'Settings must be a JSON object.' };
    try {
      const channel = channelName(value);
      if (channel === '') throw new ConnectorError('Mattermost needs the channel to post into.');
      return { ok: true, settings: { url: baseUrl(value), team: teamName(value), channel } };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Mattermost settings are incomplete.' };
    }
  },
  test(settings, token) {
    return probeMattermost(typed(settings, token));
  },
  async listTargets(settings, token): Promise<ConnectorTarget[]> {
    const base = baseUrl(settings);
    const team = encodeURIComponent(teamName(settings));
    const teamBody = await requestJson(`${base}/api/v4/teams/name/${team}`, token);
    const teamId = isObject(teamBody) && typeof teamBody.id === 'string' ? teamBody.id : '';
    if (teamId === '') throw new ConnectorError(`Mattermost has no team called ${teamName(settings)}.`);

    const channels = await requestJson(`${base}/api/v4/users/me/teams/${encodeURIComponent(teamId)}/channels`, token);
    if (!Array.isArray(channels)) throw new ConnectorError('Mattermost answered without a channel list.');
    return channels.flatMap((channel) => {
      if (!isObject(channel) || typeof channel.name !== 'string' || channel.name === '') return [];
      return [{ id: channel.name, label: channel.name }];
    });
  },
  targetRef(settings) {
    const channel = channelName(settings);
    return channel === '' ? undefined : channel;
  },
};
