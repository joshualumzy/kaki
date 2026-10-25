import { networkInterfaces as readNetworkInterfaces } from 'node:os';

/** Where the phone join links should point, or why they cannot be built. */
export type JoinBaseUrlResult =
  | { ok: true; baseUrl: string }
  | { ok: false; error: string };

/** Inputs for building the join base URL; tests swap these out. */
export interface JoinBaseUrlSources {
  env?: NodeJS.ProcessEnv;
  networkInterfaces?: typeof readNetworkInterfaces;
}

const DEFAULT_WEB_PORT = '5173';

function firstLanIpv4(
  interfaces: ReturnType<typeof readNetworkInterfaces>,
): string | undefined {
  for (const entries of Object.values(interfaces)) {
    if (entries === undefined) continue;
    const match = entries.find((info) => info.family === 'IPv4' && !info.internal);
    if (match !== undefined) return match.address;
  }
  return undefined;
}

/** Resolve the URL phones should open: KAKI_PUBLIC_URL, else this machine's LAN address. */
export function resolveJoinBaseUrl({
  env = process.env,
  networkInterfaces = readNetworkInterfaces,
}: JoinBaseUrlSources = {}): JoinBaseUrlResult {
  const publicUrl = env.KAKI_PUBLIC_URL?.trim();
  if (publicUrl !== undefined && publicUrl !== '') {
    const baseUrl = publicUrl.replace(/\/+$/, '');
    if (baseUrl !== '') return { ok: true, baseUrl };
  }

  const rawPort = env.KAKI_WEB_PORT?.trim() || DEFAULT_WEB_PORT;
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: `KAKI_WEB_PORT must be a port number, got "${rawPort}".` };
  }

  const address = firstLanIpv4(networkInterfaces());
  if (address === undefined) {
    return {
      ok: false,
      error: 'No LAN IPv4 address found. Set KAKI_PUBLIC_URL to the URL phones should open.',
    };
  }

  return { ok: true, baseUrl: `http://${address}:${port}` };
}
