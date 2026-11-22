import { describe, expect, it } from 'vitest';
import { loadConfig, REQUIRED_KEYS } from '../src/config.js';
import { ENV } from './fake.js';

describe('loadConfig', () => {
  it('returns trimmed settings and strips trailing slashes from the URL', () => {
    const config = loadConfig(ENV);
    expect(config).toEqual({
      tenantId: 'tenant-id',
      clientId: 'client-id',
      clientSecret: 'secret-value',
      subscriptionId: 'sub-id',
      resourceGroup: 'kaki-rg',
      vmName: 'kaki-vm',
      kakiUrl: 'https://kaki.example.com',
    });
  });

  it('names every missing setting and never echoes a value', () => {
    const withoutTenant = { ...ENV };
    delete withoutTenant.AZURE_TENANT_ID;
    let error;
    try {
      loadConfig({ ...withoutTenant, AZURE_CLIENT_SECRET: 'do-not-print-me' });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('AZURE_TENANT_ID');
    expect(error.message).not.toContain('do-not-print-me');
  });

  it('lists all keys for an empty environment', () => {
    let error;
    try {
      loadConfig({});
    } catch (caught) {
      error = caught;
    }
    for (const key of REQUIRED_KEYS) expect(error.message).toContain(key);
  });

  it('treats a whitespace-only setting as missing', () => {
    expect(() => loadConfig({ ...ENV, KAKI_VM_NAME: '   ' })).toThrow(/KAKI_VM_NAME/);
  });
});
