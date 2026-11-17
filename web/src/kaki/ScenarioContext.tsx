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

const ScenarioContext = createContext<Scenario | null>(null);
const RefreshScenarioContext = createContext<(() => Promise<Scenario>) | null>(null);

let scenarioPromise: Promise<Scenario> | undefined;

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

async function attemptScenario(): Promise<Attempt> {
  let response: Response;
  try {
    response = await fetch('/api/scenario');
  } catch (error) {
    return { status: 'starting', error };
  }
  if (!response.ok) {
    const error = new Error(`GET /api/scenario failed (${response.status})`);
    if (SERVER_STARTING_STATUSES.has(response.status)) return { status: 'starting', error };
    throw error;
  }
  return { status: 'ready', scenario: parseScenario(await response.json()) };
}

async function fetchScenario({ onRetry }: { onRetry?: () => void } = {}): Promise<Scenario> {
  const startedAt = Date.now();
  for (;;) {
    const attempt = await attemptScenario();
    if (attempt.status === 'ready') return attempt.scenario;
    if (Date.now() - startedAt >= SERVER_START_TIMEOUT_MS) throw attempt.error;
    onRetry?.();
    await wait(SERVER_START_RETRY_DELAY_MS);
  }
}

function loadScenario(onRetry?: () => void): Promise<Scenario> {
  scenarioPromise ??= fetchScenario({ onRetry }).catch((error: unknown) => {
    scenarioPromise = undefined;
    throw error;
  });
  return scenarioPromise;
}

/** Fetch the active scenario once and make it available to every page. */
export function ScenarioProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ScenarioState>({ status: 'loading' });
  const [starting, setStarting] = useState(false);
  const loadId = useRef(0);

  const start = useCallback(() => {
    const id = (loadId.current += 1);
    setStarting(false);
    setState({ status: 'loading' });
    // Not id-guarded: a remount (StrictMode) reuses the cached load, whose callback is the first mount's.
    loadScenario(() => setStarting(true))
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
  }, []);

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
    const fresh = await fetchScenario();
    scenarioPromise = Promise.resolve(fresh);
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

/** Re-fetch `/api/scenario` when a new meeting starts so the browser gets the shuffled agenda order. */
export function useRefreshScenario(): () => Promise<Scenario> {
  const refresh = useContext(RefreshScenarioContext);
  return refresh ?? fetchScenario;
}
