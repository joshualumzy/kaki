export const ENV = {
  AZURE_TENANT_ID: 'tenant-id',
  AZURE_CLIENT_ID: 'client-id',
  AZURE_CLIENT_SECRET: 'secret-value',
  AZURE_SUBSCRIPTION_ID: 'sub-id',
  KAKI_RESOURCE_GROUP: 'kaki-rg',
  KAKI_VM_NAME: 'kaki-vm',
  KAKI_URL: 'https://kaki.example.com/',
};

export const TOKEN_URL = 'https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token';
export const VM_URL =
  'https://management.azure.com/subscriptions/sub-id/resourceGroups/kaki-rg' +
  '/providers/Microsoft.Compute/virtualMachines/kaki-vm';
export const HEALTH_URL = 'https://kaki.example.com/health';

export function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    json: async () => body,
  };
}

export function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const call = {
      url: String(url),
      method: (init.method ?? 'GET').toUpperCase(),
      headers: init.headers ?? {},
      body: init.body,
      signal: init.signal,
    };
    calls.push(call);
    return handler(call);
  };
  return { fetchImpl, calls };
}

export const isToken = (call) => call.url === TOKEN_URL;
export const isInstanceView = (call) =>
  call.method === 'GET' && call.url.startsWith(`${VM_URL}/instanceView?`);
export const isStart = (call) => call.method === 'POST' && call.url.startsWith(`${VM_URL}/start?`);
export const isHealth = (call) => call.url === HEALTH_URL;

export function powerState(power) {
  return response(200, {
    statuses: [{ code: 'ProvisioningState/succeeded' }, { code: `PowerState/${power}` }],
  });
}

/** One fake that routes token, instance view, start and health by URL. */
export function azureRouter(options = {}) {
  const {
    power = 'running',
    health = 200,
    tokenStatus = 200,
    instanceStatus = 200,
    startStatus = 202,
  } = options;

  return (call) => {
    if (isToken(call)) {
      return tokenStatus === 200
        ? response(200, { access_token: 'test-token', expires_in: 3600 })
        : response(tokenStatus, { error: 'denied' });
    }
    if (isInstanceView(call)) {
      return instanceStatus === 200 ? powerState(power) : response(instanceStatus, {});
    }
    if (isStart(call)) {
      return response(startStatus, {});
    }
    if (isHealth(call)) {
      return typeof health === 'function' ? health(call) : response(health, {});
    }
    throw new Error(`Unexpected fetch: ${call.method} ${call.url}`);
  };
}
