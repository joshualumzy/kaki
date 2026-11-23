import { isRoleIn, type Role, type Scenario } from '@kaki/shared';

/**
 * Who a socket belongs to: the shared screen (the owner's), one role's phone, the AI runner's
 * authenticated service channel, a read-only lifecycle feed any signed-in person may follow, or a
 * participant's projection bound to their own seat. A participant never reads the owner's screen:
 * the projection carries the shared meeting state and redacts other people's private work.
 *
 * The kind is a separate namespace from role ids: a setup may name any role, including one whose
 * id happens to read `participant`, and it is still a role.
 */
export type ClientAudience =
  | { kind: 'screen' }
  | { kind: 'service' }
  | { kind: 'lifecycle' }
  | { kind: 'participant' }
  | { kind: 'role'; role: Role };

/** The audience of one role's phone or AI seat. */
export function roleAudience(role: Role): ClientAudience {
  return { kind: 'role', role };
}

/** The role behind an audience, or undefined for a screen, feed or projection. */
export function audienceRole(audience: ClientAudience): Role | undefined {
  return audience.kind === 'role' ? audience.role : undefined;
}

/** A stable name for logs; a role id can never collide with a special audience. */
export function audienceLabel(audience: ClientAudience): string {
  return audience.kind === 'role' ? audience.role : audience.kind;
}

/** A stable key for one audience, so a socket's subscriptions compare and de-duplicate by value. */
export function audienceKey(audience: ClientAudience): string {
  return audience.kind === 'role' ? `role:${audience.role}` : audience.kind;
}

/**
 * Read the audiences one page follows from repeated `?audiences=screen&audiences=role:<role>`. A
 * page opens one socket and subscribes to all the feeds its parts read, instead of one per part.
 * Absent means the older single-audience socket that `audienceFor` describes.
 */
export function audiencesFor(scenario: Scenario, url: URL): ClientAudience[] | undefined {
  const tokens = url.searchParams.getAll('audiences');
  if (tokens.length === 0) return undefined;
  // The two forms never mix: one socket either names one channel or its whole page's channels.
  if (url.searchParams.get('audience') !== null || url.searchParams.get('role') !== null) {
    return undefined;
  }
  const audiences: ClientAudience[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    let audience: ClientAudience | undefined;
    if (token.startsWith('role:')) {
      const role = token.slice('role:'.length);
      if (!isRoleIn(scenario, role)) return undefined;
      audience = roleAudience(role);
    } else if (token === 'screen') {
      audience = { kind: 'screen' };
    } else if (token === 'participant') {
      audience = { kind: 'participant' };
    } else if (token === 'lifecycle') {
      audience = { kind: 'lifecycle' };
    } else {
      return undefined;
    }
    const key = audienceKey(audience);
    if (seen.has(key)) continue;
    seen.add(key);
    audiences.push(audience);
  }
  return audiences.length === 0 ? undefined : audiences;
}

/**
 * Read the audience a page socket names for one command. A page socket follows several feeds, so
 * each command says which of them it acts as; anything else is refused.
 */
export function audienceFromValue(scenario: Scenario, value: unknown): ClientAudience | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === 'screen' || kind === 'participant' || kind === 'lifecycle') return { kind };
  if (kind !== 'role') return undefined;
  const role = (value as { role?: unknown }).role;
  return typeof role === 'string' && isRoleIn(scenario, role) ? roleAudience(role) : undefined;
}

/** Reads the requested audience from a socket URL, or undefined when the request is malformed. */
export function audienceFor(scenario: Scenario, url: URL): ClientAudience | undefined {
  const rawAudience = url.searchParams.get('audience');
  const rawRole = url.searchParams.get('role');
  // The explicit audience channel is the only way to ask for a projection or a feed. A role id is
  // never read from it, so every role id stays available to the phone and runner channels.
  if (rawAudience !== null) {
    if (rawRole !== null) return undefined;
    if (rawAudience === 'screen') return { kind: 'screen' };
    if (rawAudience === 'service') return { kind: 'service' };
    if (rawAudience === 'lifecycle') return { kind: 'lifecycle' };
    if (rawAudience === 'participant') return { kind: 'participant' };
    return undefined;
  }
  if (rawRole === null) return undefined;
  // A defined role always wins over a special name, so `participant`, `service` and `lifecycle`
  // are ordinary role ids whenever the setup defines them. The fallback keeps older clients that
  // still ask for a special audience through `role=` working when no such role exists.
  if (isRoleIn(scenario, rawRole)) return roleAudience(rawRole);
  if (rawRole === 'screen') return { kind: 'screen' };
  if (rawRole === 'service') return { kind: 'service' };
  if (rawRole === 'lifecycle') return { kind: 'lifecycle' };
  if (rawRole === 'participant') return { kind: 'participant' };
  return undefined;
}
