import { useEffect, useMemo, useState } from 'react';
import type { Scenario } from '@kaki/shared';
import { useScenario } from '../kaki';
import { fetchWithTimeout } from '../net/withTimeout';
import '../demo/demo.css';

const LOBBY_POLL_MS = 4_000;

interface LobbyParticipant {
  name: string;
  seat: string;
}

function participantsOf(value: unknown): LobbyParticipant[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const record = entry as Record<string, unknown>;
    return typeof record.name === 'string' && typeof record.seat === 'string'
      ? [{ name: record.name, seat: record.seat }]
      : [];
  });
}

async function errorOf(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === 'string' ? body.error : `${fallback} (HTTP ${response.status})`;
}

function seatLabel(scenario: Scenario, seat: string): string {
  return scenario.roles.find((role) => role.id === seat)?.label ?? seat;
}

/** Covers the stage for a participant until the owner starts the meeting. */
export function WaitingOverlay({ meetingTitle }: { meetingTitle?: string } = {}) {
  return (
    <div className="kd-start" role="region" aria-label="Waiting for the meeting to start">
      <div className="kd-start-card">
        {meetingTitle === undefined || meetingTitle.trim() === '' ? null : (
          <p className="kd-sub">{meetingTitle}</p>
        )}
        <h2>Waiting for the meeting owner to start</h2>
        <p>You are in the meeting room. The meeting begins when the owner starts it.</p>
      </div>
    </div>
  );
}

/**
 * The owner's lobby before Start: the invite link and code, who has joined, and the one Start button.
 * It polls the server's small meeting state so the list fills as people arrive.
 */
export function OwnerLobby({ initialCode, onStarted }: { initialCode?: string; onStarted(): void }) {
  const scenario = useScenario();
  const [code, setCode] = useState<string | undefined>(initialCode);
  const [participants, setParticipants] = useState<LobbyParticipant[]>([]);
  const [problem, setProblem] = useState<string | undefined>();
  const [loaded, setLoaded] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [copied, setCopied] = useState(false);
  const [copyProblem, setCopyProblem] = useState<string | undefined>();
  const [starting, setStarting] = useState(false);
  const [closing, setClosing] = useState(false);
  const [startError, setStartError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function load(): Promise<void> {
      try {
        const [codeResponse, stateResponse, peopleResponse] = await Promise.all([
          fetchWithTimeout('/api/meeting-code', { signal: controller.signal }),
          fetchWithTimeout('/api/meeting/state', { signal: controller.signal }),
          fetchWithTimeout('/api/meeting/participants', { signal: controller.signal }),
        ]);
        if (cancelled) return;
        if (!codeResponse.ok) {
          setProblem(await errorOf(codeResponse, 'Could not read the meeting code'));
          return;
        }
        if (!stateResponse.ok) {
          setProblem(await errorOf(stateResponse, 'Could not read the meeting state'));
          return;
        }
        if (!peopleResponse.ok) {
          setProblem(await errorOf(peopleResponse, 'Could not read who has joined'));
          return;
        }
        const codeBody = (await codeResponse.json().catch(() => null)) as { code?: unknown } | null;
        const stateBody = (await stateResponse.json().catch(() => null)) as
          | { started?: unknown }
          | null;
        const peopleBody = (await peopleResponse.json().catch(() => null)) as
          | { participants?: unknown }
          | null;
        if (cancelled) return;
        if (typeof codeBody?.code === 'string' && codeBody.code.trim() !== '') {
          setCode(codeBody.code.trim());
        }
        setParticipants(participantsOf(peopleBody?.participants));
        setLoaded(true);
        setProblem(undefined);
        if (stateBody?.started === true) onStarted();
      } catch (error) {
        if (cancelled) return;
        setProblem(error instanceof Error ? error.message : 'Could not read the meeting room.');
      }
    }

    void load();
    const timer = window.setInterval(() => void load(), LOBBY_POLL_MS);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [onStarted, retryKey]);

  const inviteLink = useMemo(() => {
    if (code === undefined || code === '') return undefined;
    const origin = typeof window === 'undefined' ? '' : window.location.origin;
    return `${origin}/join?code=${encodeURIComponent(code)}`;
  }, [code]);

  async function copyLink(): Promise<void> {
    if (inviteLink === undefined) return;
    setCopyProblem(undefined);
    try {
      if (navigator.clipboard?.writeText === undefined) throw new Error('no clipboard');
      await navigator.clipboard.writeText(inviteLink);
      setCopied(true);
    } catch {
      setCopied(false);
      setCopyProblem('Could not copy the link. Select it and copy it yourself.');
    }
  }

  async function start(): Promise<void> {
    if (starting) return;
    setStarting(true);
    setStartError(undefined);
    try {
      const response = await fetchWithTimeout('/api/meeting/start', { method: 'POST' }, 15_000);
      const body = (await response.json().catch(() => ({}))) as { error?: unknown; started?: unknown };
      if (!response.ok || body.started !== true) {
        throw new Error(
          typeof body.error === 'string' ? body.error : `Could not start the meeting (HTTP ${response.status}).`,
        );
      }
      onStarted();
    } catch (error) {
      setStartError(error instanceof Error ? error.message : 'Could not start the meeting.');
    } finally {
      setStarting(false);
    }
  }

  async function closeRoom(): Promise<void> {
    if (closing || starting) return;
    setClosing(true);
    setStartError(undefined);
    try {
      const response = await fetchWithTimeout('/api/meeting/close', { method: 'POST' }, 12_000);
      const body = (await response.json().catch(() => ({}))) as { error?: unknown };
      if (!response.ok) {
        throw new Error(
          typeof body.error === 'string' ? body.error : `Could not close the room (HTTP ${response.status}).`,
        );
      }
      window.location.assign('/setup');
    } catch (error) {
      setStartError(error instanceof Error ? error.message : 'Could not close the room.');
      setClosing(false);
    }
  }

  return (
    <div className="kd-start" role="region" aria-label="Meeting lobby">
      <div className="kd-start-card kd-start-card-wide">
        <h2>Your meeting room</h2>
        <p>Share the invite link, then start the meeting when everyone has joined.</p>

        {problem !== undefined ? (
          <div className="connection-banner setup-alert" role="alert">
            <p>{problem}</p>
            <button type="button" className="kd-chip" onClick={() => setRetryKey((key) => key + 1)}>
              Try again
            </button>
          </div>
        ) : null}

        {inviteLink === undefined ? (
          <p className="kd-hint">{loaded ? 'The server sent no meeting code.' : 'Getting the meeting code…'}</p>
        ) : (
          <div className="kd-lobby-invite">
            <p className="kd-label">Invite link</p>
            <p className="kd-lobby-link">
              <a href={inviteLink}>{inviteLink}</a>
            </p>
            <div className="kd-lobby-actions">
              <button type="button" className="kd-chip" onClick={() => void copyLink()}>
                {copied ? 'Copied' : 'Copy link'}
              </button>
              <span>
                Meeting code: <strong>{code}</strong>
              </span>
            </div>
            {copyProblem === undefined ? null : <p className="kd-alert">{copyProblem}</p>}
          </div>
        )}

        <div className="kd-lobby-people">
          <p className="kd-label">In the room</p>
          {participants.length === 0 ? (
            <p className="kd-hint">No one yet. Share the link to invite your team.</p>
          ) : (
            <ul>
              {participants.map((person) => (
                <li key={`${person.name}-${person.seat}`}>
                  {person.name} <span>· {seatLabel(scenario, person.seat)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {startError === undefined ? null : (
          <p className="kd-alert" role="alert">
            {startError}
          </p>
        )}
        <div className="kd-start-actions">
          <button type="button" className="kd-go" onClick={() => void start()} disabled={starting || closing}>
            {starting ? 'Starting…' : 'Start the meeting'}
          </button>
          <button
            type="button"
            className="kd-chip"
            onClick={() => void closeRoom()}
            disabled={starting || closing}
          >
            {closing ? 'Closing…' : 'Close the meeting room'}
          </button>
        </div>
      </div>
    </div>
  );
}
