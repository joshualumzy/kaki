import { isObject } from '@kaki/shared';
import { probeWiki, type WikiSettings } from '../../action/wiki';
import { ConnectorError, type ConnectorTarget, type ToolConnector } from '../connector';

const TIMEOUT_MS = 5_000;

function baseUrl(settings: Record<string, unknown>): string {
  const url = settings.url;
  if (typeof url !== 'string' || url.trim() === '') throw new ConnectorError('The wiki needs its URL.');
  return url.replace(/\/+$/, '');
}

function typed(settings: Record<string, unknown>, token: string): WikiSettings {
  const email = settings.email;
  if (typeof email !== 'string' || email.trim() === '') throw new ConnectorError('The wiki needs its login email.');
  return { url: baseUrl(settings), email: email.trim(), password: token };
}

const LOGIN_QUERY = `mutation Login($username: String!, $password: String!, $strategy: String!) {
  authentication { login(username: $username, password: $password, strategy: $strategy) {
    jwt responseResult { succeeded message } } }
}`;

const PAGES_QUERY = `query Pages { pages { list(limit: 50) { path } } }`;

async function graphql(url: string, query: string, variables: Record<string, unknown>, jwt?: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${url}/graphql`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(jwt === undefined ? {} : { authorization: `Bearer ${jwt}` }),
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ConnectorError('The wiki is not answering. Check that it is running.');
  }
  if (!response.ok) throw new ConnectorError(`The wiki returned HTTP ${response.status}.`);
  try {
    return await response.json();
  } catch {
    throw new ConnectorError('The wiki answered with something that is not JSON.');
  }
}

/** The team wiki: one login that writes pages. */
export const wikiConnector: ToolConnector = {
  kind: 'wiki',
  normalizeSettings(value) {
    if (!isObject(value)) return { ok: false, error: 'Settings must be a JSON object.' };
    try {
      const url = baseUrl(value);
      const email = value.email;
      if (typeof email !== 'string' || email.trim() === '') {
        throw new ConnectorError('The wiki needs its login email.');
      }
      const prefix = typeof value.prefix === 'string' && value.prefix.trim() !== '' ? value.prefix.trim() : undefined;
      return {
        ok: true,
        settings: { url, email: email.trim(), ...(prefix === undefined ? {} : { prefix }) },
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Wiki settings are incomplete.' };
    }
  },
  test(settings, token) {
    return probeWiki(typed(settings, token));
  },
  async listTargets(settings, token): Promise<ConnectorTarget[]> {
    const typedSettings = typed(settings, token);
    const login = await graphql(typedSettings.url, LOGIN_QUERY, {
      username: typedSettings.email,
      password: typedSettings.password,
      strategy: 'local',
    });
    const loginValue =
      isObject(login) && isObject(login.data) && isObject(login.data.authentication) && isObject(login.data.authentication.login)
        ? login.data.authentication.login
        : undefined;
    const jwt = loginValue !== undefined && typeof loginValue.jwt === 'string' ? loginValue.jwt : '';
    if (jwt === '') throw new ConnectorError('The wiki rejected the saved login.');

    const pages = await graphql(typedSettings.url, PAGES_QUERY, {}, jwt);
    const list =
      isObject(pages) && isObject(pages.data) && isObject(pages.data.pages) && Array.isArray(pages.data.pages.list)
        ? pages.data.pages.list
        : undefined;
    if (list === undefined) throw new ConnectorError('The wiki answered without a page list.');
    const paths = new Set<string>();
    for (const page of list) {
      if (isObject(page) && typeof page.path === 'string' && page.path.trim() !== '') {
        paths.add(page.path.trim());
      }
    }
    return [...paths].sort().map((path) => ({ id: path, label: path }));
  },
  targetRef(settings) {
    const prefix = settings.prefix;
    return typeof prefix === 'string' && prefix.trim() !== '' ? prefix.trim() : undefined;
  },
};
