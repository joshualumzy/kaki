import type { NetworkInterfaceInfo } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { resolveJoinBaseUrl } from '../src/joinInfo';

function info(
  address: string,
  family: 'IPv4' | 'IPv6',
  internal = false,
): NetworkInterfaceInfo {
  const base = {
    address,
    netmask: family === 'IPv4' ? '255.255.255.0' : 'ffff::',
    mac: '00:00:00:00:00:00',
    internal,
    cidr: null,
  };
  return family === 'IPv4' ? { ...base, family } : { ...base, family, scopeid: 0 };
}

describe('resolveJoinBaseUrl', () => {
  it('uses KAKI_PUBLIC_URL and trims trailing slashes', () => {
    const networkInterfaces = vi.fn(() => ({}));

    const result = resolveJoinBaseUrl({
      env: { KAKI_PUBLIC_URL: ' https://meet.example.com/kaki// ' },
      networkInterfaces,
    });

    expect(result).toEqual({ ok: true, baseUrl: 'https://meet.example.com/kaki' });
    expect(networkInterfaces).not.toHaveBeenCalled();
  });

  it('uses the first non-internal IPv4 address and KAKI_WEB_PORT', () => {
    const result = resolveJoinBaseUrl({
      env: { KAKI_WEB_PORT: '8080' },
      networkInterfaces: () => ({
        lo0: [info('127.0.0.1', 'IPv4', true)],
        en0: [info('fe80::1', 'IPv6'), info('192.168.1.42', 'IPv4')],
        en1: [info('10.0.0.7', 'IPv4')],
      }),
    });

    expect(result).toEqual({ ok: true, baseUrl: 'http://192.168.1.42:8080' });
  });

  it('defaults KAKI_WEB_PORT to 5173', () => {
    const result = resolveJoinBaseUrl({
      env: {},
      networkInterfaces: () => ({ en0: [info('192.168.1.42', 'IPv4')] }),
    });

    expect(result).toEqual({ ok: true, baseUrl: 'http://192.168.1.42:5173' });
  });

  it('fails with a clear error when no LAN IPv4 address exists', () => {
    const result = resolveJoinBaseUrl({
      env: {},
      networkInterfaces: () => ({ lo0: [info('127.0.0.1', 'IPv4', true)] }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('KAKI_PUBLIC_URL');
  });

  it('fails when KAKI_WEB_PORT is not a port number', () => {
    const result = resolveJoinBaseUrl({
      env: { KAKI_WEB_PORT: 'vite' },
      networkInterfaces: () => ({ en0: [info('192.168.1.42', 'IPv4')] }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('KAKI_WEB_PORT');
  });
});
