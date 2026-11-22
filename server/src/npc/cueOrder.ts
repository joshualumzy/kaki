/**
 * Keeps an AI attendee's answer behind the host's question. Sam hands a task to an AI colleague with a spoken cue, and the colleague
 * decides what to say while the cue waits for a quiet moment; without this the answer can be heard first (or the question dropped
 * while the answer plays). The answer runs once the latest cue has been said or dropped, receiving `spoken: false` if the cue was
 * dropped so the colleague can claim the task silently without answering a question nobody heard.
 */
export function createCueOrder(timeoutMs = 25_000): {
  /** Starts a host cue; `speak` must call `done(spoken)` when the cue has been said (`true`) or dropped (`false`). */
  cue(speak: (done: (spoken?: boolean) => void) => void): void;
  /** Runs `run(spoken)` once the latest cue is over (at once with `true` when there is none). */
  after(run: (spoken: boolean) => void): void;
} {
  let pending: Promise<boolean> = Promise.resolve(true);
  return {
    cue(speak) {
      pending = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref();
        speak((spoken = true) => {
          clearTimeout(timer);
          resolve(spoken);
        });
      });
    },
    after(run) {
      void pending.then(run);
    },
  };
}
