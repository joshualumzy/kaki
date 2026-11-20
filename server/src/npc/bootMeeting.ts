import type { RunnerMeetingSnapshot, Scenario } from '@kaki/shared';

/** Build the scenario the runner boots with from a server snapshot over the on-disk pack. */
export function scenarioFromRunnerSnapshot(base: Scenario, snapshot: RunnerMeetingSnapshot): Scenario {
  return {
    ...base,
    ...(snapshot.meetingTitle === undefined ? {} : { meetingTitle: snapshot.meetingTitle }),
    roles: snapshot.roles,
    npcs: snapshot.cast,
    agenda: snapshot.agenda,
  };
}

export interface WaitForRunnerCastOptions {
  base: Scenario;
  fetchState(): Promise<RunnerMeetingSnapshot>;
  log?(message: string): void;
  /** Delay between reads while the server has no AI cast yet. */
  retryMs?: number;
  /** Stop waiting (for example on SIGINT) instead of polling forever. */
  signal?: AbortSignal;
}

export interface RunnerCastBoot {
  snapshot: RunnerMeetingSnapshot;
  scenario: Scenario;
}

/**
 * A pack can be saved with no AI seat (or started before one was added). The runner must not exit:
 * wait for the server's snapshot to name an AI cast, then boot with exactly that cast.
 */
export async function waitForRunnerCast({
  base,
  fetchState,
  log = () => undefined,
  retryMs = 3_000,
  signal,
}: WaitForRunnerCastOptions): Promise<RunnerCastBoot> {
  let announced = false;
  for (;;) {
    if (signal?.aborted === true) throw new Error('stopped while waiting for an AI cast');
    try {
      const snapshot = await fetchState();
      if (snapshot.cast.length > 0) {
        return { snapshot, scenario: scenarioFromRunnerSnapshot(base, snapshot) };
      }
      if (!announced) {
        announced = true;
        log('the on-disk pack has no AI cast; waiting for the server to publish a meeting with one');
      }
    } catch (error) {
      if (!announced) {
        announced = true;
        log(`the on-disk pack has no AI cast and the server state cannot be read yet: ${String(error)}`);
      }
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, retryMs);
      timer.unref?.();
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}
