import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { parseScenario, type Scenario } from '@kaki/shared';
import { Button, Card } from '../ui';

type ScenarioState =
  | { status: 'loading' }
  | { status: 'ready'; scenario: Scenario }
  | { status: 'error'; message: string };

/**
 * Which scenario a page needs: the practice page follows the pack, independent of the owner's
 * real-meeting draft; every other page follows the meeting in progress.
 */
export type ScenarioView = 'practice' | 'meeting';

const ScenarioContext = createContext<Scenario | null>(null);
const RefreshScenarioContext = createContext<(() => Promise<Scenario>) | null>(null);

const scenarioPromises: Partial<Record<ScenarioView, Promise<Scenario>>> = {};

/** Practice pages follow the pack; every other page follows the meeting in progress. */
export function viewForPath(pathname: string): ScenarioView {
  return pathname === '/practice' || pathname === '/demo' ? 'practice' : 'meeting';
}

function scenarioUrl(view: ScenarioView): string {
  return view === 'practice' ? '/api/scenario?kind=practice' : '/api/scenario';
}

/** How long to keep retrying while the API server is starting behind the reverse proxy. */
const SERVER_START_TIMEOUT_MS = 90_000;
const SERVER_START_RETRY_DELAY_MS = 1_000;

/** Statuses meaning the reverse proxy is up but the API server behind it is not yet. */
const SERVER_STARTING_STATUSES = new Set([502, 503, 504]);

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Attempt =
  | { status: 'ready'; scenario: Scenario }
  | { status: 'starting'; error: unknown };

async function attemptScenario(view: ScenarioView): Promise<Attempt> {
  let response: Response;
  try {
    response = await fetch(scenarioUrl(view));
  } catch (error) {
    return { status: 'starting', error };
  }
  if (!response.ok) {
    const error = new Error(`GET ${scenarioUrl(view)} failed (${response.status})`);
    if (SERVER_STARTING_STATUSES.has(response.status)) return { status: 'starting', error };
    throw error;
  }
  return { status: 'ready', scenario: parseScenario(await response.json()) };
}

async function fetchScenario(
  view: ScenarioView,
  { onRetry }: { onRetry?: () => void } = {},
): Promise<Scenario> {
  const startedAt = Date.now();
  for (;;) {
    const attempt = await attemptScenario(view);
    if (attempt.status === 'ready') return attempt.scenario;
    if (Date.now() - startedAt >= SERVER_START_TIMEOUT_MS) throw attempt.error;
    onRetry?.();
    await wait(SERVER_START_RETRY_DELAY_MS);
  }
}

function loadScenario(view: ScenarioView, onRetry?: () => void): Promise<Scenario> {
  scenarioPromises[view] ??= fetchScenario(view, { onRetry }).catch((error: unknown) => {
    scenarioPromises[view] = undefined;
    throw error;
  });
  return scenarioPromises[view];
}

/** Fetch the active scenario once per view and make it available to every page. */
export function ScenarioProvider({
  children,
  view = 'meeting',
}: {
  children: ReactNode;
  view?: ScenarioView;
}) {
  const [state, setState] = useState<ScenarioState>({ status: 'loading' });
  const [starting, setStarting] = useState(false);
  const loadId = useRef(0);

  const start = useCallback(() => {
    const id = (loadId.current += 1);
    setStarting(false);
    setState({ status: 'loading' });
    // Not id-guarded: a remount (StrictMode) reuses the cached load, whose callback is the first mount's.
    loadScenario(view, () => setStarting(true))
      .then((scenario) => {
        if (loadId.current === id) setState({ status: 'ready', scenario });
      })
      .catch((error: unknown) => {
        if (loadId.current !== id) return;
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : 'Could not load the scenario',
        });
      });
  }, [view]);

  useEffect(() => {
    start();
    return () => {
      loadId.current += 1;
    };
  }, [start]);

  if (state.status === 'loading') {
    return (
      <main className="page">
        <p className="empty-state">
          {starting ? 'Starting up… this can take a few seconds.' : 'Loading scenario…'}
        </p>
      </main>
    );
  }

  if (state.status === 'error') {
    return (
      <main className="page">
        <Card title="Could not load the scenario">
          <p className="connection-banner" role="alert">
            {state.message}
          </p>
          <Button onClick={start}>Try again</Button>
        </Card>
      </main>
    );
  }

  async function refresh(): Promise<Scenario> {
    const fresh = await fetchScenario(view);
    scenarioPromises[view] = Promise.resolve(fresh);
    setState({ status: 'ready', scenario: fresh });
    return fresh;
  }

  return (
    <RefreshScenarioContext.Provider value={refresh}>
      <ScenarioContext.Provider value={state.scenario}>{children}</ScenarioContext.Provider>
    </RefreshScenarioContext.Provider>
  );
}

/** The active scenario; only valid inside ScenarioProvider. */
export function useScenario(): Scenario {
  const scenario = useContext(ScenarioContext);
  if (scenario === null) throw new Error('useScenario must be used inside ScenarioProvider');
  return scenario;
}

/** Re-fetch the page's scenario when a new meeting starts so the browser gets the shuffled agenda order. */
export function useRefreshScenario(): () => Promise<Scenario> {
  const refresh = useContext(RefreshScenarioContext);
  return refresh ?? (() => fetchScenario('meeting'));
}
