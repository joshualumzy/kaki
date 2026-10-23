import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { parseScenario, type Scenario } from '@kaki/shared';
import { Card } from '../ui';

type ScenarioState =
  | { status: 'loading' }
  | { status: 'ready'; scenario: Scenario }
  | { status: 'error'; message: string };

const ScenarioContext = createContext<Scenario | null>(null);

let scenarioPromise: Promise<Scenario> | undefined;

function loadScenario(): Promise<Scenario> {
  scenarioPromise ??= (async () => {
    const response = await fetch('/api/scenario');
    if (!response.ok) {
      throw new Error(`GET /api/scenario failed (${response.status})`);
    }
    return parseScenario(await response.json());
  })();
  return scenarioPromise;
}

/** Fetch the active scenario once and make it available to every page. */
export function ScenarioProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ScenarioState>({ status: 'loading' });

  useEffect(() => {
    let active = true;
    loadScenario()
      .then((scenario) => {
        if (active) setState({ status: 'ready', scenario });
      })
      .catch((error: unknown) => {
        if (!active) return;
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : 'Could not load the scenario',
        });
      });
    return () => {
      active = false;
    };
  }, []);

  if (state.status === 'loading') {
    return (
      <main className="page">
        <p className="empty-state">Loading scenario…</p>
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
        </Card>
      </main>
    );
  }

  return <ScenarioContext.Provider value={state.scenario}>{children}</ScenarioContext.Provider>;
}

/** The active scenario; only valid inside ScenarioProvider. */
export function useScenario(): Scenario {
  const scenario = useContext(ScenarioContext);
  if (scenario === null) throw new Error('useScenario must be used inside ScenarioProvider');
  return scenario;
}
