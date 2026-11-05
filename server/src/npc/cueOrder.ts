/**
 * Keeps an AI attendee's answer behind the host's question. Sam hands a task to an AI colleague with a spoken cue, and the colleague
 * decides what to say while the cue waits for a quiet moment; without this the answer can be heard first (or the question dropped
 * while the answer plays). The answer runs once the latest cue has been said or dropped, or after `timeoutMs` if neither is reported.
 */
export function createCueOrder(timeoutMs = 25_000): {
  /** Starts a host cue; `speak` must call `done` when the cue has been said or dropped. */
  cue(speak: (done: () => void) => void): void;
  /** Runs `run` once the latest cue is over (at once when there is none). */
  after(run: () => void): void;
} {
  let pending: Promise<void> = Promise.resolve();
  return {
    cue(speak) {
      pending = new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        timer.unref();
        speak(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
    after(run) {
      void pending.then(run);
    },
  };
}
