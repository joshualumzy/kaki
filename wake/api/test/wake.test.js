import { beforeEach, describe, expect, it } from 'vitest';
import { resetTokenCache } from '../src/azure.js';
import { wakeHandler } from '../src/handlers.js';
import { ENV, azureRouter, fakeFetch, isHealth, isInstanceView, isStart } from './fake.js';

beforeEach(() => {
  resetTokenCache();
});

describe('POST /api/wake', () => {
  it.each(['deallocated', 'stopped'])('starts a %s VM', async (power) => {
    const { fetchImpl, calls } = fakeFetch(azureRouter({ power, startStatus: 202 }));

    const result = await wakeHandler(ENV, { fetchImpl });

    expect(result).toEqual({ status: 200, jsonBody: { started: true } });
    const starts = calls.filter(isStart);
    expect(starts).toHaveLength(1);
    expect(starts[0].headers.Authorization).toBe('Bearer test-token');
    expect(calls.filter(isHealth)).toHaveLength(0);
  });

  it.each(['running', 'starting'])('does not start a %s VM', async (power) => {
    const { fetchImpl, calls } = fakeFetch(azureRouter({ power }));

    const result = await wakeHandler(ENV, { fetchImpl });

    expect(result).toEqual({ status: 200, jsonBody: { started: false, power } });
    expect(calls.filter(isStart)).toHaveLength(0);
  });

  it.each(['deallocating', 'stopping'])('returns 409 while the VM is %s', async (power) => {
    const { fetchImpl, calls } = fakeFetch(azureRouter({ power }));

    const result = await wakeHandler(ENV, { fetchImpl });

    expect(result).toEqual({
      status: 409,
      jsonBody: { error: 'Kaki is switching off; try again in a minute' },
    });
    expect(calls.filter(isStart)).toHaveLength(0);
  });

  it('returns 409 for an unexpected power state', async () => {
    const { fetchImpl, calls } = fakeFetch(azureRouter({ power: 'unknown' }));

    const result = await wakeHandler(ENV, { fetchImpl });

    expect(result.status).toBe(409);
    expect(result.jsonBody.error).toContain('unknown');
    expect(calls.filter(isStart)).toHaveLength(0);
  });

  it('returns 502 with the status code when the start call fails', async () => {
    const { fetchImpl } = fakeFetch(azureRouter({ power: 'deallocated', startStatus: 500 }));

    const result = await wakeHandler(ENV, { fetchImpl });

    expect(result.status).toBe(502);
    expect(result.jsonBody.error).toContain('500');
  });

  it('returns 502 when the power state cannot be read', async () => {
    const { fetchImpl, calls } = fakeFetch(azureRouter({ power: 'deallocated', instanceStatus: 429 }));

    const result = await wakeHandler(ENV, { fetchImpl });

    expect(result.status).toBe(502);
    expect(result.jsonBody.error).toContain('429');
    expect(calls.filter(isStart)).toHaveLength(0);
    expect(calls.filter(isInstanceView)).toHaveLength(1);
  });

  it('returns 500 naming a missing setting', async () => {
    const { fetchImpl } = fakeFetch(() => {
      throw new Error('should not be called');
    });

    const result = await wakeHandler({ ...ENV, KAKI_RESOURCE_GROUP: '' }, { fetchImpl });

    expect(result.status).toBe(500);
    expect(result.jsonBody.error).toContain('KAKI_RESOURCE_GROUP');
  });
});
