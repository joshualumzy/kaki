/** What the `/idle` endpoint tells the VM's idle checker about the server right now. */
export interface IdleSnapshot {
  /** Open WebSocket connections from people; the AI runner's sockets never count. */
  peopleConnected: number;
  /** When a person last made an HTTP request or sent a WebSocket frame, as an ISO timestamp. */
  lastActivityAt: string;
  /** Whole seconds since that activity, measured against the injected clock. */
  idleSeconds: number;
}

/** Tracks the evidence the VM uses to decide whether anybody is still using Kaki. */
export interface IdleTracker {
  /** Record one person's HTTP request or WebSocket frame. */
  recordActivity(): void;
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
  let lastActivityMs = now();
  let people = 0;

  return {
    recordActivity() {
      lastActivityMs = now();
    },
    personConnected() {
      people += 1;
    },
    personDisconnected() {
      people = Math.max(0, people - 1);
    },
    snapshot() {
      const idleMs = Math.max(0, now() - lastActivityMs);
      return {
        peopleConnected: people,
        lastActivityAt: new Date(lastActivityMs).toISOString(),
        idleSeconds: Math.floor(idleMs / 1000),
      };
    },
  };
}
