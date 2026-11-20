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
import { fetchWithTimeout } from '../net/withTimeout';
import { Button, Card } from '../ui';
import { scenarioRevision, subscribeScenarioRevision } from './scenarioRevision';

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
/** A single request must answer well inside the overall start-up limit. */
const SERVER_START_ATTEMPT_TIMEOUT_MS = 10_000;

/** Statuses meaning the reverse proxy is up but the API server behind it is not yet. */
const SERVER_STARTING_STATUSES = new Set([502, 503, 504]);

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Attempt =
  | { status: 'ready'; scenario: Scenario }
  | { status: 'starting'; error: unknown };

async function attemptScenario(view: ScenarioView, timeoutMs: number): Promise<Attempt> {
  let response: Response;
  try {
    response = await fetchWithTimeout(scenarioUrl(view), {}, timeoutMs);
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
  const deadline = startedAt + SERVER_START_TIMEOUT_MS;
  for (;;) {
    const remaining = Math.max(0, deadline - Date.now());
    const attempt = await attemptScenario(
      view,
      Math.max(1, Math.min(SERVER_START_ATTEMPT_TIMEOUT_MS, remaining)),
    );
    if (attempt.status === 'ready') return attempt.scenario;
    if (Date.now() >= deadline) throw attempt.error;
    onRetry?.();
    await wait(Math.min(SERVER_START_RETRY_DELAY_MS, Math.max(0, deadline - Date.now())));
  }
}

/**
 * Fetch the scenario for the meeting revision the provider knows. The revision is the identity of
 * the answer: when it changes the provider loads again, so a page can never keep a scenario that
 * describes an older meeting or an older plan.
 */
function loadScenario(view: ScenarioView, onRetry?: () => void): Promise<Scenario> {
  return fetchScenario(view, { onRetry });
}

/** Fetch the active scenario for the meeting the browser knows and make it available to every page. */
export function ScenarioProvider({
  children,
  view = 'meeting',
}: {
  children: ReactNode;
  view?: ScenarioView;
}) {
  const [state, setState] = useState<ScenarioState>({ status: 'loading' });
  const [starting, setStarting] = useState(false);
  const [revision, setRevision] = useState(scenarioRevision);
  const [retryCount, setRetryCount] = useState(0);
  const loadId = useRef(0);
  /** The view currently on screen: a change of view shows Loading, a refresh keeps the page usable. */
  const shownView = useRef<ScenarioView | undefined>(undefined);
  /** The revision the scenario on screen belongs to: never show it for a different meeting. */
  const shownRevision = useRef<number | undefined>(undefined);

  useEffect(() => subscribeScenarioRevision(() => setRevision(scenarioRevision())), []);

  const start = useCallback(() => {
    setStarting(false);
    setRetryCount((count) => count + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const id = (loadId.current += 1);
    const viewChanged = shownView.current !== view;
    if (viewChanged) {
      setStarting(false);
      setState({ status: 'loading' });
    }
    loadScenario(view, () => {
      if (!cancelled && loadId.current === id) setStarting(true);
    })
      .then((scenario) => {
        if (cancelled || loadId.current !== id) return;
        shownView.current = view;
        shownRevision.current = revision;
        setStarting(false);
        setState({ status: 'ready', scenario });
      })
      .catch((error: unknown) => {
        if (cancelled || loadId.current !== id) return;
        if (shownView.current === view && shownRevision.current === revision) {
          // A background refresh failed for the same meeting. Keep the last scenario the page can
          // show, and say so. A new revision must never fall back to the previous meeting's plan.
          console.error('kaki web: could not refresh the scenario; keeping the last one', error);
          return;
        }
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : 'Could not load the scenario',
        });
      });
    return () => {
      cancelled = true;
    };
  }, [view, revision, retryCount]);

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
          <div className="setup-tool-actions">
            <Button onClick={start}>Try again</Button>
            {/* A signed-in owner can always fix the plan from setup, even when the meeting scenario is unreadable. */}
            <a href="/setup">Go to setup</a>
          </div>
        </Card>
      </main>
    );
  }

  async function refresh(): Promise<Scenario> {
    const id = (loadId.current += 1);
    const askedRevision = scenarioRevision();
    const fresh = await fetchScenario(view);
    // Only the newest load may apply, and only if no invalidation happened while it was in flight:
    // otherwise a manual refresh could put back the meeting the provider has already left behind.
    if (loadId.current === id && scenarioRevision() === askedRevision) {
      shownView.current = view;
      shownRevision.current = askedRevision;
      setState({ status: 'ready', scenario: fresh });
    }
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
