type Listener = () => void;

/**
 * The scenario every page shows describes one meeting. This module owns the version of that
 * meeting the browser knows about: a setup write, a new meeting identity or a change of kind
 * bumps it, and every mounted scenario reader fetches again for the current view.
 *
 * The version is module-level because the provider sits above the router: a page navigation alone
 * does not remount it, but the meeting behind it may already be different.
 */
let version = 0;
let meetingId: string | undefined;
let kind: 'real' | 'practice' | undefined;
const listeners = new Set<Listener>();

function bump(): void {
  version += 1;
  for (const listener of [...listeners]) listener();
}

/** The current revision the provider loads its scenario for. */
export function scenarioRevision(): number {
  return version;
}

/** Mark the scenario stale because the plan it describes changed (setup save, blank, import, open...). */
export function invalidateScenario(): void {
  bump();
}

/**
 * Note the meeting this browser now follows. A lifecycle event or state answer carries the
 * meeting id and sometimes its kind; only an actual change invalidates the scenario.
 */
export function noteMeetingIdentity(next: { meetingId?: string; kind?: 'real' | 'practice' }): void {
  const nextId = next.meetingId ?? meetingId;
  const nextKind = next.kind ?? kind;
  if (nextId === meetingId && nextKind === kind) return;
  meetingId = nextId;
  kind = nextKind;
  bump();
}

/** Subscribe to scenario invalidations. Returns the unsubscribe function. */
export function subscribeScenarioRevision(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
