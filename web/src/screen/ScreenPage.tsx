import { useEffect, useMemo, useState } from 'react';
import { assigneeLabel, humanSeatRoles, roleLabel, type KakiCommand, type KakiEvent, type Scenario, type Task } from '@kaki/shared';
import { Navigate } from 'react-router-dom';
import './screen.css';
import { useMe } from '../auth/useMe';
import { useKaki, useScenario } from '../kaki';
import { Button, Card, ConnectionBanner, RejectionBanner, StatusPill, resolveArtifactUrl, summarizeEvent } from '../ui';
import { JoinPhones } from './JoinPhones';

/** Shared screen shell: asks the host to sign in when auth is on, then shows the meeting. */
export function ScreenPage() {
  const auth = useMe();

  if (auth.status === 'loading') {
    return (
      <main className="page">
        <p className="empty-state">Checking sign-in…</p>
      </main>
    );
  }

  if (auth.status === 'error') {
    return (
      <main className="page">
        <Card title="Could not check sign-in">
          <p className="connection-banner" role="alert">
            {auth.message}
          </p>
        </Card>
      </main>
    );
  }

  if (auth.me.authEnabled && auth.me.kind !== 'host') {
    return <Navigate to="/login" replace />;
  }

  return <ScreenFeed />;
}

/** Tasks wait for a decision, are being worked on, or are finished. Dismissed ones leave the board. */
const COLUMNS: { id: string; title: string; hint: string; statuses: Task['status'][] }[] = [
  { id: 'suggested', title: 'Suggested', hint: 'Kaki heard these: dispatch or dismiss', statuses: ['SUGGESTED'] },
  { id: 'active', title: 'In progress', hint: 'With the owner', statuses: ['DISPATCHED', 'CLAIMED', 'DRAFT_READY', 'RUNNING', 'FAILED'] },
  { id: 'done', title: 'Done', hint: 'Finished and synced', statuses: ['COMPLETED', 'SYNCED'] },
];

/** The meeting screen itself, only mounted once the host is allowed in. */
function ScreenFeed() {
  const scenario = useScenario();
  const { events, tasks, rejection, connected, restoredAt, meetingId, send } = useKaki('screen');
  const [showJoin, setShowJoin] = useState(false);
  const taskList = [...tasks.values()];
  const minutesTask = taskList.find(
    (task) => task.purpose === 'meeting_minutes' && task.artifactUrl !== undefined,
  );
  const record = events.filter(isRecord).at(-1);
  const speechRecording = events
    .filter((event): event is Extract<KakiEvent, { type: 'SPEECH_RECORDING' }> => event.type === 'SPEECH_RECORDING')
    .at(-1)?.payload.recording;
  // After an end the closing line is the last host cue; a new meeting clears the feed.
  const meetingEnded = events.some((event) => event.type === 'HOST_SPEECH_TRIGGERED' && event.payload.kind === 'CLOSING');
  const activity = events.filter((event) => !isRecord(event)).slice(-40).reverse();

  return (
    <main className="sc">
      <header className="sc-top">
        <div className="sc-brand">
          <span className="sc-logo">K</span>
          <div>
            <p className="sc-eyebrow">Kaki Host · Shared panel</p>
            <h1>{scenario.meetingTitle}</h1>
          </div>
        </div>
        <div className="sc-top-right">
          <span className="sc-live" data-on={connected}>
            <i />
            {connected ? 'Live' : 'Reconnecting'}
          </span>
          <Button variant="ghost" onClick={() => setShowJoin((open) => !open)}>
            {showJoin ? 'Close' : 'Join on phone'}
          </Button>
          {record !== undefined && !meetingEnded ? (
            <Button variant="ghost" onClick={() => send({ type: 'END_MEETING' })}>
              End meeting
            </Button>
          ) : null}
        </div>
      </header>

      {connected ? null : <ConnectionBanner />}
      {speechRecording === false ? (
        <RejectionBanner message="Speech is not being recorded: the AI service is not connected." />
      ) : null}
      {rejection === null ? null : <RejectionBanner message={`${rejection.commandType}: ${rejection.reason}`} />}
      {restoredAt === undefined ? null : (
        <div className="connection-banner sc-restored" role="status">
          <span>Restored meeting from {new Date(restoredAt).toLocaleString()}.</span>
          <Button variant="ghost" onClick={() => send({ type: 'NEW_MEETING' })}>
            New meeting
          </Button>
        </div>
      )}
      {record?.payload.notetakerStatus === 'stale' ? (
        <p className="connection-banner" role="status">
          Kaki's notes are paused — questions and tasks may be out of date. The agenda clock is still running.
        </p>
      ) : null}

      {minutesTask?.artifactUrl !== undefined ? (
        <section className="sc-panel" aria-label="End-of-meeting minutes" style={{ marginBottom: 16 }}>
          <p className="sc-eyebrow">Kaki Host · Meeting Minutes Published</p>
          <p style={{ margin: '4px 0 8px' }}>
            Full meeting notes (agenda items, action items, open questions, and transcript) are live on the team wiki.
          </p>
          <a className="artifact-link" href={resolveArtifactUrl(minutesTask.artifactUrl)} target="_blank" rel="noreferrer">
            Open meeting minutes in Wiki ↗
          </a>
        </section>
      ) : null}

      {showJoin ? (
        <div className="sc-join">
          <JoinPhones meetingId={meetingId} />
        </div>
      ) : null}

      <div className="sc-grid">
        <section className="sc-panel sc-agenda" aria-label="Agenda">
          {record === undefined ? (
            <p className="empty-state">The meeting has not started. The clock begins with the first thing said.</p>
          ) : (
            <AgendaPanel record={record} scenario={scenario} ended={meetingEnded} />
          )}
        </section>

        <section className="sc-panel sc-activity" aria-label="Activity">
          <h2 className="sc-h">Live feed</h2>
          {activity.length === 0 ? (
            <p className="empty-state">Nothing yet.</p>
          ) : (
            <ul className="sc-feed">
              {activity.map((event, index) => (
                <li key={`${event.type}-${index}`} data-kind={event.type}>
                  <span className="sc-feed-kind">{feedLabel(event)}</span>
                  <span>{summarizeEvent(event)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section aria-label="Tasks">
        <h2 className="sc-h">Tasks</h2>
        <div className="sc-board">
          {COLUMNS.map((column) => {
            const inColumn = taskList.filter((task) => column.statuses.includes(task.status));
            return (
              <div className="sc-col" key={column.id} data-col={column.id}>
                <div className="sc-col-head">
                  <b>{column.title}</b>
                  <span className="sc-count">{inColumn.length}</span>
                </div>
                <p className="sc-col-hint">{column.hint}</p>
                {inColumn.length === 0 ? (
                  <p className="sc-empty">—</p>
                ) : (
                  inColumn.map((task) => <ScreenTask key={task.id} task={task} scenario={scenario} send={send} />)
                )}
              </div>
            );
          })}
        </div>
      </section>
    </main>
  );
}

function feedLabel(event: KakiEvent): string {
  switch (event.type) {
    case 'HOST_SPEECH_TRIGGERED':
      return 'Host';
    case 'TRANSCRIPT_CHUNK':
      return 'Said';
    case 'NUDGE':
      return 'Nudge';
    case 'FACT_FOUND':
      return 'Fact';
    case 'TASK_UPDATED':
      return 'Task';
    default:
      return 'Event';
  }
}

export type RecordEvent = Extract<KakiEvent, { type: 'MEETING_RECORD_UPDATED' }>;

export function isRecord(event: KakiEvent): event is RecordEvent {
  return event.type === 'MEETING_RECORD_UPDATED';
}

/**
 * The server sends a record only when something changes, plus a heartbeat every 30 s of meeting
 * time, so count up locally in between. Stop a little after a missed heartbeat: the meeting may be over.
 */
const MAX_COUNT_UP_SECONDS = 35;

function useCountUp(elapsedSeconds: number, record: RecordEvent, frozen = false): number {
  // Each record is a new object, so this restarts the count whenever one arrives.
  const receivedAt = useMemo(() => Date.now(), [record]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (frozen) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [frozen]);
  if (frozen) return elapsedSeconds;
  return elapsedSeconds + Math.min(MAX_COUNT_UP_SECONDS, Math.max(0, (now - receivedAt) / 1000));
}

function formatMinutes(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${String(Math.floor(totalSeconds % 60)).padStart(2, '0')}`;
}

function ringColour(over: boolean): string {
  return over ? 'var(--color-danger)' : 'var(--color-host)';
}

/** The big agenda view: a clock ring, the four items as a timeline, open questions, talk time and who is quiet. */
function AgendaPanel({ record, scenario, ended = false }: { record: RecordEvent; scenario: Scenario; ended?: boolean }) {
  const { agendaIndex, openQuestions, quietRoles = [], speakerTalkSeconds, paused } = record.payload;
  const elapsed = useCountUp(record.payload.elapsedSeconds, record, ended || paused === true);
  const item = scenario.agenda[agendaIndex];
  const limit = (item?.minutes ?? 0) * 60;
  const over = limit > 0 && elapsed >= limit;
  const fraction = limit === 0 ? 0 : Math.min(1, elapsed / limit);
  const radius = 84;
  const circumference = 2 * Math.PI * radius;
  const talkMax = Math.max(1, ...Object.values(speakerTalkSeconds).map((seconds) => seconds ?? 0));

  return (
    <>
      <div className="sc-clock-row">
        <div className="sc-ring" data-over={over}>
          <svg viewBox="0 0 200 200" aria-hidden="true">
            <circle cx="100" cy="100" r={radius} className="sc-ring-bg" />
            <circle
              cx="100"
              cy="100"
              r={radius}
              className="sc-ring-fg"
              stroke={ringColour(over)}
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - fraction)}
              transform="rotate(-90 100 100)"
            />
          </svg>
          <div className="sc-ring-text">
            <b>{formatMinutes(elapsed)}</b>
            <span>{ended ? 'ended' : over ? 'over time' : `of ${formatMinutes(limit)}`}</span>
          </div>
        </div>
        <div className="sc-now">
          <p className="sc-eyebrow">
            {ended
              ? `Meeting ended · ${scenario.agenda.length} of ${scenario.agenda.length} items completed`
              : `Now · item ${agendaIndex + 1} of ${scenario.agenda.length}`}
          </p>
          <h2>{item?.title ?? 'Meeting'}</h2>
          {item === undefined ? null : <p className="sc-owner">Owner · {roleLabel(scenario, item.ownerRole)}</p>}
          <ol className="sc-steps">
            {scenario.agenda.map((step, index) => (
              <li key={step.title} data-state={ended || index < agendaIndex ? 'done' : index === agendaIndex ? 'now' : 'next'}>
                <i />
                <span>{step.title}</span>
                <em>{step.minutes}m</em>
              </li>
            ))}
          </ol>
        </div>
      </div>

      <div className="sc-two">
        <div>
          <h3 className="sc-h">Talk time · this item</h3>
          {humanSeatRoles(scenario)
            .map((role) => {
              const seconds = speakerTalkSeconds[role.id] ?? 0;
              return (
                <div className="sc-talk" key={role.id} data-quiet={quietRoles.includes(role.id)}>
                  <span>{role.label}</span>
                  <div className="sc-talk-bar">
                    <i style={{ width: `${Math.round((seconds / talkMax) * 100)}%` }} />
                  </div>
                  <em>{formatMinutes(seconds)}</em>
                </div>
              );
            })}
        </div>
        <div>
          <h3 className="sc-h">Open questions · {openQuestions.length}</h3>
          {openQuestions.length === 0 ? (
            <p className="sc-empty">None right now</p>
          ) : (
            <ul className="sc-questions">
              {openQuestions.map((question) => (
                <li key={question.id}>
                  {question.text}
                  {question.forRole === undefined ? null : <em> · {roleLabel(scenario, question.forRole)}</em>}
                </li>
              ))}
            </ul>
          )}
          {quietRoles.length === 0 ? null : (
            <p className="sc-quiet">Quiet so far: {quietRoles.map((role) => roleLabel(scenario, role)).join(', ')}</p>
          )}
        </div>
      </div>
    </>
  );
}

/** The compact Host card: the clock, agenda steps, and open questions for the current agenda item. */
export function MeetingRecordCard({
  record,
  scenario,
  ended = false,
  showOpenQuestions = true,
}: {
  record: RecordEvent;
  scenario: Scenario;
  ended?: boolean;
  showOpenQuestions?: boolean;
}) {
  const { agendaIndex, openQuestions, paused } = record.payload;
  const elapsed = useCountUp(record.payload.elapsedSeconds, record, ended || paused === true);
  const item = scenario.agenda[agendaIndex];
  const limit = (item?.minutes ?? 0) * 60;
  const over = limit > 0 && elapsed >= limit;

  return (
    <Card>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p className="eyebrow" style={{ marginBottom: 2 }}>
            {ended
              ? `Meeting ended · ${scenario.agenda.length} of ${scenario.agenda.length} items completed`
              : `Now · item ${agendaIndex + 1} of ${scenario.agenda.length}`}
          </p>
          <h2 className="card-title" style={{ margin: 0, fontSize: 16 }}>{item?.title ?? 'Meeting'}</h2>
        </div>
        <div className="kd-host-clock" style={{ flexShrink: 0 }}>
          {formatMinutes(elapsed)}{' '}
          <small style={{ fontSize: 12, fontWeight: 500, opacity: 0.75 }}>
            {ended ? 'concluded' : paused ? 'paused' : over ? 'over time' : `of ${formatMinutes(limit)}`}
          </small>
        </div>
      </div>
      <div className="kd-host-bar">
        <i style={{ width: `${ended ? 100 : limit === 0 ? 0 : Math.min(100, (elapsed / limit) * 100)}%` }} />
      </div>
      {scenario.agenda.length > 1 && (
        <ol className="sc-steps" style={{ marginTop: 10, marginBottom: showOpenQuestions && openQuestions.length > 0 ? 10 : 0 }}>
          {scenario.agenda.map((step, index) => (
            <li key={step.title} data-state={ended || index < agendaIndex ? 'done' : index === agendaIndex ? 'now' : 'next'}>
              <i />
              <span>{step.title}</span>
              <em>{step.minutes}m</em>
            </li>
          ))}
        </ol>
      )}
      {showOpenQuestions && openQuestions.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <p className="eyebrow" style={{ marginBottom: 4 }}>Open questions · {openQuestions.length}</p>
          <ul className="sc-questions" style={{ margin: 0, paddingLeft: 18 }}>
            {openQuestions.map((question) => (
              <li key={question.id}>
                {question.text}
                {question.forRole === undefined ? null : <em> · {roleLabel(scenario, question.forRole)}</em>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

function ScreenTask({
  task,
  scenario,
  send,
}: {
  task: Task;
  scenario: Scenario;
  send: (command: KakiCommand) => void;
}) {
  const assignee = task.assignee ?? task.suggestedAssignee;

  return (
    <article className="sc-task">
      <h3>{task.title}</h3>
      <p className="task-meta">
        <StatusPill status={task.status} />
        <span>{assigneeLabel(scenario, assignee)}</span>
      </p>
      {task.error === undefined ? null : <p className="task-error">{task.error}</p>}
      {task.artifactUrl !== undefined && (task.status === 'COMPLETED' || task.status === 'SYNCED') ? (
        <p>
          <a className="artifact-link" href={resolveArtifactUrl(task.artifactUrl)} target="_blank" rel="noreferrer">
            Open artifact
          </a>
          {task.actionKind === 'mattermost_post' ? ' (Mattermost may ask you to log in the first time.)' : ''}
        </p>
      ) : null}
      {task.status === 'SUGGESTED' && task.declinedBy !== undefined && task.declinedBy.length > 0 ? (
        <p className="task-meta">Declined by {task.declinedBy.map((role) => assigneeLabel(scenario, role)).join(', ')}</p>
      ) : null}
      {task.status === 'SUGGESTED' ? (
        <div className="task-actions">
          <Button onClick={() => send({ type: 'DISPATCH_TASK', taskId: task.id, assignee: task.suggestedAssignee })}>
            Dispatch to {assigneeLabel(scenario, task.suggestedAssignee)}
          </Button>
          <Button variant="ghost" onClick={() => send({ type: 'DISMISS_TASK', taskId: task.id })}>
            Dismiss
          </Button>
        </div>
      ) : null}
    </article>
  );
}
