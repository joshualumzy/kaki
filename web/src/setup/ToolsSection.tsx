import { useCallback, useEffect, useState } from 'react';
import { Button } from '../ui';
import { SetupApiError, loadTools, testTool, type ToolProbeResult, type ToolStatus } from './api';

type ToolListState =
  | { status: 'loading' }
  | { status: 'ready'; tools: ToolStatus[] }
  | { status: 'error'; message: string; forbidden: boolean };

type ProbeState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'result'; result: ToolProbeResult };

export interface ToolsSectionProps {
  /** The meeting owner sees the test buttons; everyone else gets no actions. */
  canEdit: boolean;
  /** Setup is locked after Start, so testing a connection is no longer an action. */
  started: boolean;
}

/** The server's pre-configured tools, with a read-only connection probe for each. */
export function ToolsSection({ canEdit, started }: ToolsSectionProps) {
  const [list, setList] = useState<ToolListState>({ status: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [probes, setProbes] = useState<Record<string, ProbeState>>({});

  useEffect(() => {
    let cancelled = false;
    setList({ status: 'loading' });
    loadTools()
      .then((tools) => {
        if (!cancelled) setList({ status: 'ready', tools });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const forbidden = error instanceof SetupApiError && error.status === 403;
        setList({
          status: 'error',
          message: error instanceof Error ? error.message : 'Could not check the tools.',
          forbidden,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const probe = useCallback(
    async (kind: string) => {
      setProbes((current) => ({ ...current, [kind]: { status: 'running' } }));
      try {
        const result = await testTool(kind);
        setProbes((current) => ({ ...current, [kind]: { status: 'result', result } }));
      } catch (error) {
        setProbes((current) => ({
          ...current,
          [kind]: {
            status: 'result',
            result: {
              ok: false,
              problem: 'unreachable',
              message: error instanceof Error ? error.message : 'Could not test the connection.',
            },
          },
        }));
      }
    },
    [],
  );

  return (
    <section className="card setup-section" aria-label="Tools">
      <header className="setup-section-head">
        <h2 className="card-title">Tools</h2>
      </header>
      <p className="setup-note">
        Tools are set up in the server's settings by whoever installs Kaki.
      </p>

      {list.status === 'loading' ? (
        <p className="empty-state" role="status">
          Checking tools…
        </p>
      ) : null}

      {list.status === 'error' ? (
        list.forbidden ? (
          <p className="setup-note" role="status">
            {list.message}
          </p>
        ) : (
          <>
            <p className="connection-banner" role="alert">
              {list.message}
            </p>
            {canEdit ? (
              <div className="setup-tool-actions">
                <Button variant="ghost" onClick={() => setReloadKey((key) => key + 1)} disabled={started}>
                  Try again
                </Button>
              </div>
            ) : null}
          </>
        )
      ) : null}

      {list.status === 'ready' ? (
        <ul className="setup-list setup-tools">
          {list.tools.map((tool) => {
            const probeState = probes[tool.kind] ?? { status: 'idle' };
            return (
              <li key={tool.kind}>
                <div className="setup-tool-head">
                  <p className="setup-item-title">{tool.label}</p>
                  <span className="pill" data-status={tool.configured ? 'SYNCED' : 'FAILED'}>
                    {tool.configured ? 'Connected' : 'Not connected'}
                  </span>
                </div>
                {tool.missing.length > 0 ? (
                  <p className="setup-tool-missing">Missing setting{tool.missing.length === 1 ? '' : 's'}: {tool.missing.join(', ')}</p>
                ) : null}
                {canEdit ? (
                  <div className="setup-tool-actions">
                    <Button
                      variant="ghost"
                      onClick={() => void probe(tool.kind)}
                      disabled={started || probeState.status === 'running'}
                    >
                      {probeState.status === 'running' ? 'Testing…' : 'Test connection'}
                    </Button>
                  </div>
                ) : null}
                {probeState.status === 'result' ? (
                  probeState.result.ok ? (
                    <p className="setup-tool-result" data-tone="ok" role="status">
                      Connection OK{probeState.result.detail === undefined ? '.' : `: ${probeState.result.detail}`}
                    </p>
                  ) : (
                    <p className="setup-tool-result" data-tone="failed" role="alert">
                      {probeState.result.message ?? `The connection failed (${probeState.result.problem ?? 'unknown problem'}).`}
                    </p>
                  )
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
