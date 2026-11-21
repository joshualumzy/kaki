import { beforeEach, describe, expect, it } from 'vitest';
import { resetTokenCache } from '../src/azure.js';
import { statusHandler } from '../src/handlers.js';
import { ENV, azureRouter, fakeFetch, isHealth, isInstanceView, isToken } from './fake.js';

beforeEach(() => {
  resetTokenCache();
});

describe('GET /api/status', () => {
  it.each([
    ['running', true],
    ['starting', false],
    ['deallocated', false],
    ['deallocating', false],
    ['stopped', false],
  ])('reports power "%s"', async (power, expectedHealthy) => {
    const { fetchImpl, calls } = fakeFetch(azureRouter({ power }));

    const result = await statusHandler(ENV, { fetchImpl });

    expect(result.status).toBe(200);
    expect(result.jsonBody).toEqual({ power, healthy: expectedHealthy });
    expect(calls.filter(isHealth)).toHaveLength(power === 'running' ? 1 : 0);
  });

  it('reports "unknown" when Azure has no PowerState code', async () => {
    const { fetchImpl } = fakeFetch((call) => {
      if (isToken(call)) return { ok: true, status: 200, json: async () => ({ access_token: 't', expires_in: 3600 }) };
      if (isInstanceView(call)) return { ok: true, status: 200, json: async () => ({ statuses: [] }) };
      throw new Error('unexpected');
    });

    const result = await statusHandler(ENV, { fetchImpl });

    expect(result.jsonBody).toEqual({ power: 'unknown', healthy: false });
  });

  it('probes health only while running and treats a non-200 as unhealthy', async () => {
    const { fetchImpl, calls } = fakeFetch(azureRouter({ power: 'running', health: 503 }));

    const result = await statusHandler(ENV, { fetchImpl });

    expect(result.jsonBody).toEqual({ power: 'running', healthy: false });
    expect(calls.filter(isHealth)).toHaveLength(1);
  });

  it('treats a health probe timeout as unhealthy', async () => {
    const fetchImpl = (url, init = {}) => {
      if (String(url) === 'https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token') {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ access_token: 't', expires_in: 3600 }) });
      }
      if (String(url).includes('/instanceView')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ statuses: [{ code: 'PowerState/running' }] }),
        });
      }
      // Health never answers; it must reject when the client aborts it.
      return new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    };

    const started = Date.now();
    const result = await statusHandler(ENV, { fetchImpl, healthTimeoutMs: 25 });

    expect(result.jsonBody).toEqual({ power: 'running', healthy: false });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('returns 502 with the status code when Azure rejects the instance view call', async () => {
    const { fetchImpl } = fakeFetch(azureRouter({ power: 'running', instanceStatus: 403 }));

    const result = await statusHandler(ENV, { fetchImpl });

    expect(result.status).toBe(502);
    expect(result.jsonBody.error).toContain('403');
  });

  it('returns 502 when Azure sign-in fails', async () => {
    const { fetchImpl } = fakeFetch(azureRouter({ tokenStatus: 401 }));

    const result = await statusHandler(ENV, { fetchImpl });

    expect(result.status).toBe(502);
    expect(result.jsonBody.error).toContain('401');
  });

  it('returns 500 naming missing settings, without calling Azure', async () => {
    const { fetchImpl, calls } = fakeFetch(() => {
      throw new Error('should not be called');
    });

    const result = await statusHandler({ AZURE_CLIENT_SECRET: 'do-not-print-me' }, { fetchImpl });

    expect(result.status).toBe(500);
    expect(result.jsonBody.error).toContain('AZURE_TENANT_ID');
    expect(result.jsonBody.error).not.toContain('do-not-print-me');
    expect(calls).toHaveLength(0);
  });
});

describe('token cache', () => {
  it('reuses a token until five minutes before it expires', async () => {
    let nowMs = 1_000_000;
    const now = () => nowMs;
    const { fetchImpl, calls } = fakeFetch(azureRouter({ power: 'stopped' }));

    await statusHandler(ENV, { fetchImpl, now });
    await statusHandler(ENV, { fetchImpl, now });
    expect(calls.filter(isToken)).toHaveLength(1);

    nowMs += 3_200_000;
    await statusHandler(ENV, { fetchImpl, now });
    expect(calls.filter(isToken)).toHaveLength(1);

    nowMs += 200_000;
    await statusHandler(ENV, { fetchImpl, now });
    expect(calls.filter(isToken)).toHaveLength(2);
  });
});
