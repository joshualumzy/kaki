import { createServer, type Server } from 'node:http';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { createHub } from '../../src/core/hub';
import { testScenario } from '../fixtures/scenario';

const servers: Server[] = [];
const websockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of websockets.splice(0)) socket.terminate();
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected a TCP address');
  return address.port;
}

describe('hub account revocation', () => {
  it('refuses an upgrade that authorized before the account was revoked', async () => {
    let releaseAuthorization: (() => void) | undefined;
    let markAuthorizationStarted: (() => void) | undefined;
    const authorizationStarted = new Promise<void>((resolve) => {
      markAuthorizationStarted = resolve;
    });
    const authorizationGate = new Promise<void>((resolve) => {
      releaseAuthorization = resolve;
    });

    const server = createServer();
    const hub = createHub(server, () => testScenario, {
      authorize: async () => {
        markAuthorizationStarted?.();
        await authorizationGate;
        return {
          ok: true,
          participant: false,
          principal: { kind: 'host', userId: 'account-1' },
          sessionTokenHash: 'session-1',
        };
      },
    });
    const port = await listen(server);

    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?audience=screen`);
    websockets.push(socket);
    const closed = new Promise<number>((resolve) => {
      socket.once('close', (code) => resolve(code));
      socket.once('error', () => resolve(0));
    });

    // The upgrade is authorized but has not registered yet.
    await authorizationStarted;
    await hub.endUser?.('account-1');
    if (releaseAuthorization === undefined) throw new Error('Authorization did not start');
    const release = releaseAuthorization;
    release();

    // The account generation moved while the upgrade was in flight, so it must not register.
    expect(await closed).toBe(4001);
    hub.close();
  });
});
