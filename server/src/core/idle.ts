/** What the `/idle` endpoint tells the VM's idle checker about the server right now. */
export interface IdleSnapshot {
  /** Open WebSocket connections from people; the AI runner's sockets never count. */
  peopleConnected: number;
  /** When a person last made an HTTP request or sent a WebSocket frame, as an ISO timestamp. */
  lastActivityAt: string;
  /** Whole seconds since that activity, measured against the injected clock. */
  idleSeconds: number;
  /** When a person last did something themselves, not a page on their behalf, as an ISO timestamp. */
  lastActionAt: string;
  /** Whole seconds since that real person action, measured against the injected clock. */
  actionIdleSeconds: number;
}

/** Tracks the evidence the VM uses to decide whether anybody is still using Kaki. */
export interface IdleTracker {
  /** Record one person's HTTP request or WebSocket frame. */
  recordActivity(): void;
  /** Record one real person action, such as a person's command or a line they spoke. */
  recordAction(): void;
  /** Record a person's WebSocket opening. */
  personConnected(): void;
  /** Record a person's WebSocket closing. */
  personDisconnected(): void;
  /** Read the current idle state for the idle endpoint. */
  snapshot(): IdleSnapshot;
}

/**
 * Create the idle tracker. A fresh server starts fully active, so a just-woken VM gets its whole
 * idle window rather than inheriting an old timestamp; the clock is injected so tests can move time.
 */
export function createIdleTracker(now: () => number = Date.now): IdleTracker {
  const startedMs = now();
  let lastActivityMs = startedMs;
  let lastActionMs = startedMs;
  let people = 0;

  return {
    recordActivity() {
      lastActivityMs = now();
    },
    recordAction() {
      lastActionMs = now();
    },
    personConnected() {
      people += 1;
    },
    personDisconnected() {
      people = Math.max(0, people - 1);
    },
    snapshot() {
      const idleMs = Math.max(0, now() - lastActivityMs);
      const actionIdleMs = Math.max(0, now() - lastActionMs);
      return {
        peopleConnected: people,
        lastActivityAt: new Date(lastActivityMs).toISOString(),
        idleSeconds: Math.floor(idleMs / 1000),
        lastActionAt: new Date(lastActionMs).toISOString(),
        actionIdleSeconds: Math.floor(actionIdleMs / 1000),
      };
    },
  };
}
