import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchMe } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
});

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('fetchMe', () => {
  it('tells a Google-signed-in browser who it is', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        reply({
          kind: 'user',
          user: { id: 'user-1', name: 'Ada Lovelace', email: 'ada@example.com' },
          authEnabled: true,
        }),
      ),
    );

    await expect(fetchMe()).resolves.toEqual({
      authEnabled: true,
      kind: 'user',
      user: { id: 'user-1', name: 'Ada Lovelace', email: 'ada@example.com' },
    });
  });

  it('rejects a user reply without a readable user', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => reply({ kind: 'user', user: { id: 'user-1' }, authEnabled: true })),
    );

    await expect(fetchMe()).rejects.toThrow(/Could not read the signed-in user/);
  });
});
