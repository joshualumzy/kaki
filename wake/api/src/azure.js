const MANAGEMENT_URL = 'https://management.azure.com';
const LOGIN_URL = 'https://login.microsoftonline.com';
const API_VERSION = '2024-07-01';
const TOKEN_MARGIN_MS = 5 * 60 * 1000;

const tokenCache = new Map();
const pendingTokens = new Map();

export class AzureError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'AzureError';
    this.status = status;
  }
}

/** Tests use this so one case's cached token cannot leak into the next. */
export function resetTokenCache() {
  tokenCache.clear();
  pendingTokens.clear();
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function requestToken(config, { fetchImpl, now, tokenTimeoutMs }) {
  const url = `${LOGIN_URL}/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: config.clientId,
    client_secret: config.clientSecret,
    scope: `${MANAGEMENT_URL}/.default`,
  });

  const response = await call(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  }, tokenTimeoutMs, fetchImpl);

  const payload = await readJson(response);
  if (!response.ok) {
    throw new AzureError(`Azure sign-in failed (HTTP ${response.status}).`, response.status);
  }
  if (typeof payload?.access_token !== 'string' || payload.access_token === '') {
    throw new AzureError('Azure sign-in returned no access token.', response.status);
  }

  const seconds = Number(payload.expires_in);
  const lifetimeMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
  return { token: payload.access_token, expiresAt: now() + lifetimeMs };
}

async function call(url, init, timeoutMs, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch {
    const reason = controller.signal.aborted ? 'timed out' : 'network error';
    throw new AzureError(`Could not reach Azure (${reason}).`);
  } finally {
    clearTimeout(timer);
  }
}

async function getToken(config, options) {
  // Keyed by identity so a token survives between function invocations.
  const key = `${config.tenantId}\u0000${config.clientId}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt - TOKEN_MARGIN_MS > options.now()) {
    return cached.token;
  }

  let pending = pendingTokens.get(key);
  if (!pending) {
    pending = requestToken(config, options)
      .then((entry) => {
        tokenCache.set(key, entry);
        return entry;
      })
      .finally(() => {
        pendingTokens.delete(key);
      });
    pendingTokens.set(key, pending);
  }
  return (await pending).token;
}

export function createAzureClient(config, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const healthTimeoutMs = options.healthTimeoutMs ?? 4000;
  const tokenTimeoutMs = options.tokenTimeoutMs ?? 10000;
  const armTimeoutMs = options.armTimeoutMs ?? 15000;

  const settings = { fetchImpl, now, tokenTimeoutMs };
  const vmPath = [
    '/subscriptions',
    encodeURIComponent(config.subscriptionId),
    'resourceGroups',
    encodeURIComponent(config.resourceGroup),
    'providers/Microsoft.Compute/virtualMachines',
    encodeURIComponent(config.vmName),
  ].join('/');

  async function armRequest(path, init) {
    const token = await getToken(config, settings);
    return call(`${MANAGEMENT_URL}${path}`, {
      ...init,
      headers: { ...init?.headers, Authorization: `Bearer ${token}` },
    }, armTimeoutMs, fetchImpl);
  }

  /** Azure's PowerState/* instance-view code, lowercased, or "unknown". */
  async function getPower() {
    const response = await armRequest(`${vmPath}/instanceView?api-version=${API_VERSION}`, {
      method: 'GET',
    });
    if (!response.ok) {
      throw new AzureError(`Azure management API returned HTTP ${response.status}.`, response.status);
    }
    const view = await readJson(response);
    const statuses = Array.isArray(view?.statuses) ? view.statuses : [];
    const power = statuses.find(
      (status) => typeof status?.code === 'string' && status.code.startsWith('PowerState/'),
    );
    return power ? power.code.slice('PowerState/'.length).toLowerCase() : 'unknown';
  }

  async function start() {
    const response = await armRequest(`${vmPath}/start?api-version=${API_VERSION}`, {
      method: 'POST',
    });
    if (!response.ok) {
      throw new AzureError(
        `Azure management API returned HTTP ${response.status} when starting Kaki.`,
        response.status,
      );
    }
    return response.status;
  }

  /** A slow or broken Kaki just means "not healthy yet", not an API failure. */
  async function isHealthy() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), healthTimeoutMs);
    try {
      const response = await fetchImpl(`${config.kakiUrl}/health`, {
        method: 'GET',
        signal: controller.signal,
        cache: 'no-store',
      });
      return response.status === 200;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  return { getToken: () => getToken(config, settings), getPower, start, isHealthy };
}
