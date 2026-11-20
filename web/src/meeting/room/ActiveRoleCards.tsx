import { useEffect, useRef, useState } from 'react';
import { assigneeLabel, type KakiCommand, type Scenario, type Task } from '@kaki/shared';
import { useKaki, useScenario, type KakiRejection } from '../../kaki';
import { artifactLinkText, Button, Card, RejectionBanner, StatusPill, resolveArtifactUrl, taskStatusText } from '../../ui';
import './activeRoleCards.css';

function needsAction(task: Task): boolean {
  switch (task.status) {
    case 'DISPATCHED':
    case 'DRAFT_READY':
    case 'FAILED':
    case 'COMPLETED':
      return true;
    case 'SYNCED':
      return task.artifactUrl !== undefined;
    case 'CLAIMED':
      return true;
    case 'RUNNING':
      return true;
    default:
      return false;
  }
}

function completedPlatformSummary(task: Task): string {
  switch (task.actionKind) {
    case 'mattermost_post':
      return `✓ Published to ${task.draft?.target || 'team channel'} — open Mattermost to view the live post.`;
    case 'gitea_issue':
      return '✓ Issue created in Gitea — open Gitea to view the live ticket.';
    case 'wiki_page':
      return '✓ Page published to Team Wiki — open Wiki.js to read the live SOP.';
    case 'email':
      return `✓ Email sent to ${task.draft?.target || 'recipient'} — open Mailpit to view the live email.`;
    case 'calendar_event':
      return '✓ Meeting scheduled on Team Calendar — open Calendar to view the live invite.';
    default:
      return '✓ Published live — click below to view.';
  }
}

function updatedAtMs(task: Task): number {
  const parsed = Date.parse(task.updatedAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function taskKey(task: Task): string {
  return `${task.id}:${task.status}:${task.updatedAt}`;
}

function formatTime(at: number): string | undefined {
  if (!Number.isFinite(at) || at <= 0) return undefined;
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function TimeLabel({ at }: { at: number }) {
  const label = formatTime(at);
  if (label === undefined) return null;
  return (
    <time className="phone-time" dateTime={new Date(at).toISOString()}>
      {label}
    </time>
  );
}

const MIN_SENDING_MS = 1200;

/**
 * Shows only the visitor's active task cards (when a task assigned to `role` needs action or review)
 * in the meeting room's dock, without a page header, empty state, or history list.
 */
function actionStepRank(task: Task): number {
  switch (task.status) {
    case 'DISPATCHED':
    case 'DRAFT_READY':
    case 'FAILED':
    case 'CLAIMED':
    case 'RUNNING':
    case 'COMPLETED':
      return 0;
    case 'SYNCED':
      return 1;
    default:
      return 2;
  }
}

export function ActiveRoleCards({
  role,
  viewer,
  sharedAudience = 'participant',
}: {
  role: string;
  viewer?: { name: string; seatName?: string };
  sharedAudience?: 'screen' | 'participant';
}) {
  const scenario = useScenario();
  const { tasks, rejection, send } = useKaki({ kind: 'role', role });
  const activeRef = useRef<HTMLDivElement>(null);
  const expandedRef = useRef<HTMLDivElement>(null);
  const lastScrolledKey = useRef<string>('');
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);

  // Topic changes and the closing line go to the shared projection, never to a role's private feed.
  const { events: screenEvents } = useKaki(sharedAudience === 'participant' ? { kind: 'participant' } : { kind: 'screen' });
  let currentAgendaTitle: string | undefined;
  let meetingEnded = false;
  for (const event of screenEvents) {
    if (event.type === 'MEETING_RECORD_UPDATED') {
      currentAgendaTitle = scenario.agenda[event.payload.agendaIndex]?.title;
    } else if (event.type === 'HOST_SPEECH_TRIGGERED' && event.payload.kind === 'CLOSING') {
      meetingEnded = true;
    }
  }

  const isEarlierTopicTask = (task: Task): boolean =>
    currentAgendaTitle !== undefined &&
    task.agendaItemTitle !== undefined &&
    task.agendaItemTitle !== currentAgendaTitle;

  const allTasks = [...tasks.values()];
  const currentTasks = allTasks
    .filter((task) => {
      if (!needsAction(task)) return false;
      if (task.status === 'SYNCED') {
        if (meetingEnded) return false;
        if (
          currentAgendaTitle !== undefined &&
          task.agendaItemTitle !== undefined &&
          task.agendaItemTitle !== currentAgendaTitle
        ) {
          return false;
        }
      }
      return true;
    })
    .sort((left, right) => {
      const earlierDiff = Number(isEarlierTopicTask(left)) - Number(isEarlierTopicTask(right));
      if (earlierDiff !== 0) return earlierDiff;
      const rankDiff = actionStepRank(left) - actionStepRank(right);
      if (rankDiff !== 0) return rankDiff;
      return updatedAtMs(right) - updatedAtMs(left);
    })
    .slice(0, 2);
  const currentTask = currentTasks[0];

  const actionableTaskKey =
    currentTask !== undefined &&
    (currentTask.status === 'DISPATCHED' ||
      currentTask.status === 'DRAFT_READY' ||
      currentTask.status === 'COMPLETED' ||
      currentTask.status === 'FAILED')
      ? `${currentTask.id}:${currentTask.status}`
      : '';
  const scrollTriggerKey = actionableTaskKey;

  useEffect(() => {
    if (scrollTriggerKey === '' || scrollTriggerKey === lastScrolledKey.current) return;
    lastScrolledKey.current = scrollTriggerKey;
    activeRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, [scrollTriggerKey]);

  useEffect(() => {
    if (expandedTaskId === null) return;
    // The expanded draft can be taller than the dock on a small window: show its action button, not half of it.
    expandedRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'end' });
  }, [expandedTaskId]);

  if (currentTasks.length === 0 && rejection === null) {
    return null;
  }

  return (
    <div ref={activeRef} className="phone kd-role-active">
      {rejection === null ? null : (
        <RejectionBanner message={`${rejection.commandType}: ${rejection.reason}`} />
      )}
      {currentTasks.length > 0 && (
        <section className="phone-current" aria-label="Needs you now">
          <p className="eyebrow phone-section-eyebrow">
            Needs you now{currentTasks.length > 1 ? ` (${currentTasks.length})` : ''}
          </p>
          {currentTasks.map((item) => {
            if (!isEarlierTopicTask(item)) {
              return (
                <TaskCard
                  key={taskKey(item)}
                  id={`task-${item.id}`}
                  task={item}
                  scenario={scenario}
                  send={send}
                  rejection={rejection}
                  viewer={viewer}
                />
              );
            }
            const expanded = expandedTaskId === item.id;
            if (!expanded) {
              return (
                <button
                  key={taskKey(item)}
                  type="button"
                  className="kd-role-pending-line"
                  aria-expanded="false"
                  onClick={() => setExpandedTaskId(item.id)}
                >
                  <span className="kd-role-pending-title">{item.title}</span>
                  <span className="kd-role-pending-status">{taskStatusText(item)}</span>
                  <span className="kd-role-pending-action">Review</span>
                </button>
              );
            }
            return (
              <div key={taskKey(item)} ref={expandedRef} className="kd-role-pending kd-role-pending-open">
                <button
                  type="button"
                  className="kd-role-pending-line"
                  aria-expanded="true"
                  onClick={() => setExpandedTaskId(null)}
                >
                  <span className="kd-role-pending-title">{item.title}</span>
                  <span className="kd-role-pending-status">{taskStatusText(item)}</span>
                  <span className="kd-role-pending-action">Hide</span>
                </button>
                <TaskCard
                  id={`task-${item.id}`}
                  task={item}
                  scenario={scenario}
                  send={send}
                  rejection={rejection}
                  viewer={viewer}
                />
              </div>
            );
          })}
        </section>
      )}
    </div>
  );
}

/**
 * The server can finish sending in well under a second, so the card would never show it.
 * From the moment the person approves, show "sending" for at least MIN_SENDING_MS.
 */
function TaskCard(props: {
  task: Task;
  scenario: Scenario;
  send: (command: KakiCommand) => void;
  rejection: KakiRejection | null;
  viewer?: { name: string; seatName?: string };
  id?: string;
}) {
  const { task, send, rejection } = props;
  const [approvedAt, setApprovedAt] = useState<number | null>(null);
  const [, tick] = useState(0);

  useEffect(() => {
    if (rejection !== null) setApprovedAt(null);
  }, [rejection]);

  const remaining = approvedAt === null ? 0 : approvedAt + MIN_SENDING_MS - Date.now();
  const holding = remaining > 0 && task.status !== 'FAILED' && task.error === undefined;
  useEffect(() => {
    if (!holding) return;
    const timer = setTimeout(() => tick((n) => n + 1), remaining);
    return () => clearTimeout(timer);
  }, [holding, remaining]);

  function sendAndNote(command: KakiCommand): void {
    if (command.type === 'APPROVE_ACTION') setApprovedAt(Date.now());
    send(command);
  }

  const shown: Task = holding ? { ...task, status: 'RUNNING' } : task;
  return <TaskCardBody {...props} send={sendAndNote} task={shown} />;
}

function TaskCardBody({
  task,
  scenario,
  send,
  rejection,
  viewer,
  id,
}: {
  task: Task;
  scenario: Scenario;
  send: (command: KakiCommand) => void;
  rejection: KakiRejection | null;
  viewer?: { name: string; seatName?: string };
  id?: string;
}) {
  const [body, setBody] = useState(task.draft?.body ?? '');
  const [target, setTarget] = useState(task.draft?.target ?? '');
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const draft = task.draft;

  useEffect(() => {
    setBody(task.draft?.body ?? '');
    setTarget(task.draft?.target ?? '');
  }, [task.draft?.body, task.draft?.target]);

  useEffect(() => {
    if (rejection === null) return;
    busy.current = false;
    setPending(false);
  }, [rejection]);

  useEffect(() => {
    if (task.status !== 'COMPLETED') return;
    const timer = setTimeout(() => {
      send({ type: 'SYNC_TASK', taskId: task.id });
    }, 1800);
    return () => clearTimeout(timer);
  }, [task.id, task.status, send]);

  function submit(command: KakiCommand): void {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    send(command);
  }

  const stepIndex =
    task.status === 'COMPLETED' || task.status === 'SYNCED'
      ? 3
      : task.status === 'DRAFT_READY' || task.status === 'RUNNING' || task.status === 'CLAIMED'
        ? 2
        : 1;

  return (
    <Card id={id}>
      <div className="phone-item-head">
        <p className="phone-item-kind">Task</p>
        <TimeLabel at={updatedAtMs(task)} />
      </div>
      {task.actionKind !== undefined && (
        <div className="phone-task-steps" aria-label="Task progress">
          <span className="phone-task-step" data-active={stepIndex === 1} data-done={stepIndex > 1}>
            1. Accept
          </span>
          <span className="phone-task-step-sep" aria-hidden="true">→</span>
          <span className="phone-task-step" data-active={stepIndex === 2} data-done={stepIndex > 2}>
            2. Review Draft
          </span>
          <span className="phone-task-step-sep" aria-hidden="true">→</span>
          <span className="phone-task-step" data-active={stepIndex === 3} data-done={false}>
            3. Published
          </span>
        </div>
      )}
      <h2 className="card-title phone-task-title">{task.title}</h2>
      <p className="task-meta">
        <StatusPill status={task.status} />
        <span>{assigneeLabel(scenario, task.assignee ?? task.suggestedAssignee, viewer)}</span>
      </p>
      {task.context.trim() === '' ||
      (viewer !== undefined &&
        ((task.status === 'DRAFT_READY' && task.decisionSource !== undefined) ||
          task.status === 'COMPLETED' ||
          task.status === 'SYNCED')) ? null : (
        <p className="phone-task-context">{task.context}</p>
      )}
      {task.decisionSource === undefined ||
      (viewer !== undefined && (task.status === 'COMPLETED' || task.status === 'SYNCED')) ? null : (
        <div className="phone-task-decision">
          <p className="phone-task-decision-label">Accepted decision</p>
          <p className="phone-task-decision-text">{task.decisionSource}</p>
        </div>
      )}
      {task.error === undefined ? null : (
        <p className="task-error" role="alert">
          {task.error}
        </p>
      )}

      {(task.status === 'CLAIMED' && task.mode === 'ACTION_AGENT') || task.status === 'RUNNING' ? (
        <p className="task-meta task-working" role="status" aria-live="polite">
          <span className="working-dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          {task.status === 'RUNNING' ? 'Kaki is sending this now…' : 'Kaki is drafting this… it can take up to a minute.'}
        </p>
      ) : null}

      {task.status === 'DISPATCHED' ? (
        <div className="task-actions" aria-busy={pending}>
          {task.actionKind === undefined ? null : (
            <Button
              disabled={pending}
              onClick={() =>
                submit({ type: 'CLAIM_TASK', taskId: task.id, mode: 'ACTION_AGENT' })
              }
            >
              Accept · Let Kaki do it
            </Button>
          )}
          <Button
            variant="ghost"
            disabled={pending}
            onClick={() => submit({ type: 'CLAIM_TASK', taskId: task.id, mode: 'MANUAL' })}
          >
            Accept · I&apos;ll do it
          </Button>
          <Button
            variant="ghost"
            disabled={pending}
            onClick={() => submit({ type: 'DECLINE_TASK', taskId: task.id })}
          >
            Decline
          </Button>
        </div>
      ) : null}

      {(task.status === 'DRAFT_READY' || task.status === 'FAILED') && draft !== undefined ? (
        <>
          <label className="draft-field">
            <span>To</span>
            <input
              className="draft-target"
              type="text"
              value={target}
              onChange={(event) => setTarget(event.target.value)}
            />
          </label>
          <p className="task-meta">Subject: {draft.subject}</p>
          <label className="draft-field">
            <span>Draft body</span>
            <textarea
              className="draft-body"
              rows={viewer !== undefined ? 4 : 6}
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
          </label>
        </>
      ) : null}

      {task.status === 'DRAFT_READY' && draft !== undefined ? (
        <div className="task-actions" aria-busy={pending}>
          <Button
            disabled={pending || target.trim() === ''}
            onClick={() =>
              submit({ type: 'APPROVE_ACTION', taskId: task.id, draft: { ...draft, target, body } })
            }
          >
            Approve &amp; publish
          </Button>
        </div>
      ) : null}

      {task.status === 'FAILED' ? (
        <div className="task-actions" aria-busy={pending}>
          <Button
            disabled={pending || (draft !== undefined && target.trim() === '')}
            onClick={() =>
              submit(
                draft === undefined
                  ? { type: 'RETRY_ACTION', taskId: task.id }
                  : { type: 'RETRY_ACTION', taskId: task.id, draft: { ...draft, target, body } },
              )
            }
          >
            Retry
          </Button>
        </div>
      ) : null}

      {task.status === 'CLAIMED' && task.mode === 'MANUAL' ? (
        <div className="task-actions" aria-busy={pending}>
          <Button disabled={pending} onClick={() => submit({ type: 'MARK_DONE', taskId: task.id })}>
            Mark done
          </Button>
        </div>
      ) : null}

      {task.status === 'COMPLETED' || task.status === 'SYNCED' ? (
        <div className="task-actions" aria-busy={pending}>
          <p className="task-meta" style={{ width: '100%', margin: '0 0 6px', fontWeight: 500 }}>
            {completedPlatformSummary(task)}
          </p>
          {task.artifactUrl === undefined ? null : (
            <a className="artifact-link" href={resolveArtifactUrl(task.artifactUrl)} target="_blank" rel="noreferrer">
              {artifactLinkText(task)}
            </a>
          )}
        </div>
      ) : null}
    </Card>
  );
}
