import { useEffect, useState } from 'react';
import { fetchMe, type Me } from './api';

/** The sign-in check's state: still loading, failed with a message, or the signed-in person. */
export type MeState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; me: Me };

/** How long a page waits for the sign-in check before saying so and offering a retry. */
const ME_TIMEOUT_MS = 8_000;

/**
 * Load who this browser is signed in as. `reloadKey` re-runs the check when a page offers a retry.
 */
export function useMe(reloadKey = 0, enabled = true): MeState {
  const [state, setState] = useState<MeState>({ status: 'loading' });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ME_TIMEOUT_MS);

    fetchMe(controller.signal)
      .then((me) => {
        if (!cancelled) setState({ status: 'ready', me });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          status: 'error',
          message: controller.signal.aborted
            ? 'Could not check the sign-in state: the server did not answer in time.'
            : error instanceof Error
              ? error.message
              : 'Could not check the sign-in state.',
        });
      })
      .finally(() => clearTimeout(timer));

    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [reloadKey, enabled]);

  return state;
}
