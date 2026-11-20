import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  demoPackNpcProfileIds,
  isBlankMeetingDraft,
  parseMeetingSetup,
  type MeetingSetup,
  type SetupFieldError,
} from '@kaki/shared';
import { useMe } from '../auth/useMe';
import { useScenario } from '../kaki';
import { Button, Card } from '../ui';
import {
  OpenMeetingError,
  SetupApiError,
  closeMeetingRoom,
  endPracticeMeeting,
  importKopitiamDemo,
  loadSetup,
  openMeeting,
  startBlankSetup,
} from './api';
import { SetupDraft } from './SetupDraft';
import { SetupEditor } from './SetupEditor';
import { ToolsSection } from './ToolsSection';
import './setup.css';

type SetupState =
  | { status: 'loading' }
  | { status: 'ready'; setup: MeetingSetup; started: boolean; kind?: 'real' | 'practice' }
  | { status: 'error'; message: string; signIn: boolean };

interface ImportProblem {
  message: string;
  fieldErrors: SetupFieldError[];
}

function PageHeader() {
  return (
    <header className="page-header">
      <p className="eyebrow">Kaki · Before the meeting</p>
      <h1>Set up the meeting</h1>
      <p className="page-subtitle">Check the plan before everyone arrives. Changes are saved on the server.</p>
    </header>
  );
}

function FieldProblems({ errors }: { errors: SetupFieldError[] }) {
  if (errors.length === 0) return null;
  return (
    <ul className="setup-field-errors">
      {errors.map((error) => (
        <li key={`${error.field}-${error.message}`}>
          <code>{error.field}</code> {error.message}
        </li>
      ))}
    </ul>
  );
}

/** The pre-meeting setup page: the saved draft, demo import, and the server's tool connections. */
export function SetupPage() {
  const [authKey, setAuthKey] = useState(0);
  const auth = useMe(authKey);
  const scenario = useScenario();
  const navigate = useNavigate();
  const [state, setState] = useState<SetupState>({ status: 'loading' });
  const [actionBusy, setActionBusy] = useState(false);
  const [openProblem, setOpenProblem] = useState<string | null>(null);
  const [practiceInProgress, setPracticeInProgress] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [importing, setImporting] = useState(false);
  const [importProblem, setImportProblem] = useState<ImportProblem | null>(null);
  const [startingBlank, setStartingBlank] = useState(false);
  const [confirmBlank, setConfirmBlank] = useState(false);
  const [blankProblem, setBlankProblem] = useState<string | null>(null);
  const [draftDirty, setDraftDirty] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    loadSetup()
      .then((result) => {
        if (!cancelled) {
          setState({
            status: 'ready',
            setup: result.setup,
            started: result.started,
            ...(result.kind === undefined ? {} : { kind: result.kind }),
          });
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const status = error instanceof SetupApiError ? error.status : 0;
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : 'Could not load the setup.',
          signIn: status === 401 || status === 403,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const authReady = auth.status === 'ready';
  const canEdit =
    authReady && (auth.me.authEnabled === false || (auth.me.authEnabled === true && auth.me.kind === 'host'));
  const signedOut = authReady && auth.me.authEnabled === true && auth.me.kind === null;
  const setupCheck = useMemo(
    () =>
      state.status === 'ready'
        ? parseMeetingSetup(state.setup, { npcProfileIds: demoPackNpcProfileIds(scenario) })
        : undefined,
    [state, scenario],
  );
  const setupValid = setupCheck?.ok === true;
  const setupProblems = setupCheck?.ok === false ? setupCheck.errors : [];
  const notifyDirty = useCallback((dirty: boolean) => setDraftDirty(dirty), []);

  async function openRoom(): Promise<void> {
    if (actionBusy) return;
    setActionBusy(true);
    setOpenProblem(null);
    setPracticeInProgress(false);
    try {
      await openMeeting();
      navigate('/meeting');
    } catch (error) {
      setOpenProblem(
        error instanceof Error ? error.message : 'Could not open the meeting room.',
      );
      setPracticeInProgress(error instanceof OpenMeetingError && error.practiceInProgress);
    } finally {
      setActionBusy(false);
    }
  }

  async function closeRoom(): Promise<void> {
    if (actionBusy) return;
    setActionBusy(true);
    setOpenProblem(null);
    try {
      await closeMeetingRoom();
      setReloadKey((key) => key + 1);
    } catch (error) {
      setOpenProblem(error instanceof Error ? error.message : 'Could not close the meeting room.');
    } finally {
      setActionBusy(false);
    }
  }

  async function endPractice(): Promise<void> {
    if (actionBusy) return;
    setActionBusy(true);
    setOpenProblem(null);
    try {
      await endPracticeMeeting();
      setPracticeInProgress(false);
      await openMeeting();
      navigate('/meeting');
    } catch (error) {
      setOpenProblem(
        error instanceof Error ? error.message : 'Could not end the practice meeting.',
      );
      setPracticeInProgress(error instanceof OpenMeetingError && error.practiceInProgress);
    } finally {
      setActionBusy(false);
    }
  }

  async function applyBlank(): Promise<void> {
    if (startingBlank) return;
    setStartingBlank(true);
    setBlankProblem(null);
    try {
      const result = await startBlankSetup();
      setState({ status: 'ready', setup: result.setup, started: result.started });
      setConfirmBlank(false);
      setDraftDirty(false);
    } catch (error) {
      setBlankProblem(
        error instanceof Error ? error.message : 'Could not start a blank meeting.',
      );
    } finally {
      setStartingBlank(false);
    }
  }

  function startBlank(): void {
    if (startingBlank) return;
    setBlankProblem(null);
    const hasEdits =
      draftDirty || (state.status === 'ready' && !isBlankMeetingDraft(state.setup));
    if (hasEdits) {
      setConfirmBlank(true);
      return;
    }
    void applyBlank();
  }

  async function loadDemo(): Promise<void> {
    if (importing) return;
    setImporting(true);
    setImportProblem(null);
    try {
      const result = await importKopitiamDemo();
      setState({ status: 'ready', setup: result.setup, started: result.started });
    } catch (error) {
      setImportProblem({
        message: error instanceof Error ? error.message : 'Could not load the Kopitiam demo.',
        fieldErrors: error instanceof SetupApiError ? error.fieldErrors : [],
      });
    } finally {
      setImporting(false);
    }
  }

  return (
    <main className="page setup-page">
      <PageHeader />

      {state.status === 'ready' && state.started ? (
        <p className="connection-banner setup-locked" role="status">
          The meeting has started; setup is locked. <Link to="/meeting">Go to the meeting</Link>
        </p>
      ) : null}

      {signedOut ? (
        <p className="setup-note" role="status">
          <Link to="/login?return=/setup">Sign in</Link> as the meeting owner to change the setup.
        </p>
      ) : null}

      {canEdit && state.status === 'ready' && !state.started ? (
        <section className="card setup-open" aria-label="Open the meeting room">
          <div className="setup-import-row">
            <div>
              <h2 className="card-title">Open the meeting room</h2>
              <p className="setup-note">
                Opens the room from this saved plan and gives you an invite link to send your team.
              </p>
            </div>
            <Button onClick={() => void openRoom()} disabled={!setupValid || actionBusy}>
              {actionBusy ? 'Opening…' : 'Open the meeting room'}
            </Button>
          </div>
          {state.kind === 'real' ? (
            <p className="setup-note">
              The team meeting room is open. If nobody has started it, you can release it for practice.{' '}
              <Button variant="ghost" onClick={() => void closeRoom()} disabled={actionBusy}>
                {actionBusy ? 'Closing…' : 'Close the meeting room'}
              </Button>
            </p>
          ) : null}
          {!setupValid ? (
            <div className="setup-note" role="status">
              <p>Before you can open the room:</p>
              <ul className="setup-requirements">
                {setupProblems.map((problem) => (
                  <li key={`${problem.field}-${problem.message}`}>{problem.message}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {openProblem === null ? null : (
            <div className="connection-banner setup-alert" role="alert">
              {practiceInProgress ? <p>A practice meeting is running right now.</p> : null}
              <p>{openProblem}</p>
              {practiceInProgress ? (
                <Button variant="ghost" onClick={() => void endPractice()} disabled={actionBusy}>
                  {actionBusy ? 'Ending…' : 'End the practice meeting'}
                </Button>
              ) : null}
            </div>
          )}
        </section>
      ) : null}

      {authReady && !canEdit && !signedOut && state.status === 'ready' ? (
        <p className="setup-note" role="status">
          Only the meeting owner can change the setup.
        </p>
      ) : null}

      {auth.status === 'error' ? (
        <div className="connection-banner" role="alert">
          <p>Could not check sign-in: {auth.message}</p>
          <Button variant="ghost" onClick={() => setAuthKey((key) => key + 1)}>
            Try again
          </Button>
        </div>
      ) : null}

      {state.status === 'loading' ? (
        <Card title="Meeting setup">
          <p className="empty-state" role="status">
            Loading setup…
          </p>
        </Card>
      ) : null}

      {state.status === 'error' ? (
        <Card title="Meeting setup">
          <div className="connection-banner setup-alert" role="alert">
            <p>{state.message}</p>
          </div>
          {state.signIn ? (
            <p className="setup-note">
              <Link to="/login?return=/setup">Sign in</Link>
            </p>
          ) : canEdit ? (
            <div className="setup-tool-actions">
              <Button variant="ghost" onClick={() => setReloadKey((key) => key + 1)}>
                Try again
              </Button>
            </div>
          ) : null}
        </Card>
      ) : null}

      {state.status === 'ready' ? (
        <>
          {canEdit ? (
            <section className="setup-start-options" aria-label="Choose a starting point">
              <div className="card setup-start-card">
                <h2 className="card-title">Start a blank meeting</h2>
                <p className="setup-note">
                  A title and default nudge pace, with no agenda, roles or seats yet. Add them as you
                  plan.
                </p>
                <Button
                  onClick={startBlank}
                  disabled={startingBlank || state.started}
                >
                  {startingBlank ? 'Starting blank…' : 'Start a blank meeting'}
                </Button>
                {confirmBlank ? (
                  <div className="connection-banner setup-alert" role="alert">
                    <p>Starting a blank meeting replaces the current plan and its edits.</p>
                    <div className="setup-tool-actions">
                      <Button onClick={() => void applyBlank()} disabled={startingBlank}>
                        {startingBlank ? 'Replacing…' : 'Replace with a blank plan'}
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => setConfirmBlank(false)}
                        disabled={startingBlank}
                      >
                        Keep this plan
                      </Button>
                    </div>
                  </div>
                ) : null}
                {blankProblem === null ? null : (
                  <div className="connection-banner setup-alert" role="alert">
                    <p>{blankProblem}</p>
                  </div>
                )}
              </div>

              <div className="card setup-start-card">
                <h2 className="card-title">Use the Kopitiam template</h2>
                <p className="setup-note">
                  Reads the practice calendar invite, then fills roles and seats from the demo pack.
                  Every seat starts as a person; you can switch a seat to an AI stand-in.
                </p>
                <Button onClick={() => void loadDemo()} disabled={importing || state.started}>
                  {importing ? 'Loading template…' : 'Use the Kopitiam template'}
                </Button>
                {importProblem === null ? null : (
                  <div className="connection-banner setup-alert" role="alert">
                    <p>{importProblem.message}</p>
                    <FieldProblems errors={importProblem.fieldErrors} />
                  </div>
                )}
              </div>
            </section>
          ) : null}

          {canEdit && !state.started ? (
            <SetupEditor
              setup={state.setup}
              scenario={scenario}
              onSaved={(setup) => setState({ status: 'ready', setup, started: false })}
              onDirtyChange={notifyDirty}
            />
          ) : (
            <SetupDraft setup={state.setup} />
          )}

          {canEdit ? <ToolsSection canEdit={canEdit} started={state.started} /> : null}
        </>
      ) : null}
    </main>
  );
}
