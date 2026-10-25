import { useEffect, useState } from 'react';
import { fetchMe, type Me } from './api';

export type MeState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; me: Me };

/** Load who this browser is signed in as, once per mount. */
export function useMe(): MeState {
  const [state, setState] = useState<MeState>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();

    fetchMe(controller.signal)
      .then((me) => setState({ status: 'ready', me }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : 'Could not check the sign-in state.',
        });
      });

    return () => controller.abort();
  }, []);

  return state;
}
