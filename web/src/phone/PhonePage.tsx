import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  assigneeLabel,
  humanAttendeeForRole,
  humanSeatRoles,
  roleLabel,
  type Fact,
  type KakiCommand,
  type KakiEvent,
  type Scenario,
  type Task,
} from '@kaki/shared';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { joinMeeting } from '../auth/api';
import { useMe } from '../auth/useMe';
import { useKaki, useScenario, type KakiRejection } from '../kaki';
import { Button, Card, ConnectionBanner, RejectionBanner, StatusPill, resolveArtifactUrl } from '../ui';
import '../auth/auth.css';
import './phone.css';

interface StampedEvent {
  id: number;
  event: KakiEvent;
  receivedAt: number;
}

type NudgeEvent = Extract<KakiEvent, { type: 'NUDGE' }>;
type StampedNudge = StampedEvent & { event: NudgeEvent };

function isStampedNudge(item: StampedEvent): item is StampedNudge {
  return item.event.type === 'NUDGE';
}

function useStampedEvents(events: KakiEvent[]): StampedEvent[] {
  const stamps = useRef(new WeakMap<KakiEvent, { id: number; receivedAt: number }>());
  const nextId = useRef(0);
  const [stamped, setStamped] = useState<StampedEvent[]>([]);

  useEffect(() => {
    const now = Date.now();
    let assigned = false;
    const next = events.map((event) => {
      let stamp = stamps.current.get(event);
      if (stamp === undefined) {
        stamp = { id: nextId.current, receivedAt: now };
        nextId.current += 1;
        stamps.current.set(event, stamp);
        assigned = true;
      }
      return { event, ...stamp };
    });
    setStamped((previous) => (assigned || previous.length !== next.length ? next : previous));
  }, [events]);

  return stamped;
}

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

function taskStatusText(task: Task): string {
  switch (task.status) {
    case 'CLAIMED':
      return task.mode === 'ACTION_AGENT' ? 'drafting…' : 'accepted';
    case 'DRAFT_READY':
      return 'reviewing draft…';
    case 'RUNNING':
      return 'publishing…';
    default:
      return task.status.replace('_', ' ').toLowerCase();
  }
}

function openLivePlatformLabel(task: Task): string {
  switch (task.actionKind) {
    case 'mattermost_post':
      return 'Open live in Mattermost ↗';
    case 'gitea_issue':
      return 'Open live in Gitea ↗';
    case 'wiki_page':
      return 'Open live in Wiki ↗';
    case 'email':
      return 'Open live in Mailpit ↗';
    case 'calendar_event':
      return 'Open live in Calendar ↗';
    default:
      return 'Open live artifact ↗';
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

/** Phone shell: joins once, remembers the role, then shows only that role's events and tasks. */
export function PhonePage() {
  const scenario = useScenario();
  const [params] = useSearchParams();
  const auth = useMe();
  const [joinedRole, setJoinedRole] = useState<string | null>(null);

  if (auth.status === 'loading') {
    return (
      <main className="phone">
        <p className="empty-state">Checking sign-in…</p>
      </main>
    );
  }

  if (auth.status === 'error') {
    return (
      <main className="phone">
        <Card title="Could not check sign-in">
          <p className="connection-banner" role="alert">
            {auth.message}
          </p>
        </Card>
      </main>
    );
  }

  if (!auth.me.authEnabled) {
    const requestedRole = params.get('role');
    const role = humanSeatRole(scenario, requestedRole);
    if (role !== undefined) return <PhoneFeed role={role} />;
    return requestedRole === null ? <RolePicker /> : <RoleNotAvailable role={requestedRole} />;
  }

  const sessionRole = auth.me.kind === 'participant' ? humanSeatRole(scenario, auth.me.role) : undefined;
  const role = joinedRole ?? sessionRole;
  if (role !== undefined) return <PhoneFeed role={role} />;

  const requestedRole = humanSeatRole(scenario, params.get('role')) ?? '';
  return (
    <JoinForm
      initialCode={params.get('code') ?? ''}
      initialRole={requestedRole}
      notice={auth.me.kind === null ? auth.me.reason : undefined}
      onJoined={setJoinedRole}
    />
  );
}

/** The canonical role id a phone may open, or undefined when this is not a human seat. */
function humanSeatRole(scenario: Scenario, role: string | null | undefined): string | undefined {
  return role === null || role === undefined ? undefined : humanAttendeeForRole(scenario, role)?.role;
}

function RoleNotAvailable({ role }: { role: string }) {
  return (
    <main className="phone">
      <header className="phone-header">
        <p className="eyebrow">Kaki · Your phone</p>
        <h1>Role not available</h1>
      </header>
      <Card title="This role has no phone">
        <p className="task-error" role="alert">
          &quot;{role}&quot; is not a human seat in this meeting. Scan the QR code on the shared screen for your role.
        </p>
      </Card>
    </main>
  );
}

function RolePicker() {
  const scenario = useScenario();
  const navigate = useNavigate();

  return (
    <main className="phone">
      <header className="phone-header">
        <p className="eyebrow">Kaki · Your phone</p>
        <h1>Who are you?</h1>
      </header>
      <p className="phone-intro">Pick your meeting role to open your private panel.</p>
      <Card title="Roles">
        <div className="role-picker">
          {humanSeatRoles(scenario).map((role) => (
            <Button key={role.id} onClick={() => navigate(`/phone?role=${role.id}`)}>
              {role.label}
            </Button>
          ))}
        </div>
      </Card>
    </main>
  );
}

function JoinForm({
  initialCode,
  initialRole,
  notice,
  onJoined,
}: {
  initialCode: string;
  initialRole: string;
  notice?: string;
  onJoined: (role: string) => void;
}) {
  const scenario = useScenario();
  const [code, setCode] = useState(initialCode.toUpperCase());
  const [role, setRole] = useState(initialRole);
  const [error, setError] = useState<string | null>(notice ?? null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy.current) return;

    if (code.trim() === '') {
      setError('Enter the meeting code.');
      return;
    }
    if (role === '') {
      setError('Choose your role.');
      return;
    }

    busy.current = true;
    setPending(true);
    setError(null);
    const result = await joinMeeting(code.trim(), role);
    busy.current = false;
    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    onJoined(result.role);
  }

  return (
    <main className="phone">
      <header className="phone-header">
        <p className="eyebrow">Kaki · Your phone</p>
        <h1>Join the meeting</h1>
      </header>
      <p className="phone-intro">
        Enter the code shown on the shared screen, then pick your role.
      </p>
      <Card title="Join">
        <form className="join-form" onSubmit={(event) => void submit(event)} noValidate>
          <label className="auth-field">
            <span>Meeting code</span>
            <input
              className="auth-input"
              value={code}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
              maxLength={6}
              autoCapitalize="characters"
              autoComplete="off"
              inputMode="text"
              placeholder="ABC123"
              autoFocus={code === ''}
            />
          </label>
          <label className="auth-field">
            <span>Your role</span>
            <select
              className="auth-input"
              value={role}
              onChange={(event) => setRole(event.target.value)}
            >
              <option value="">Choose a role</option>
              {humanSeatRoles(scenario).map((scenarioRole) => (
                <option key={scenarioRole.id} value={scenarioRole.id}>
                  {scenarioRole.label}
                </option>
              ))}
            </select>
          </label>
          {error === null ? null : (
            <p className="task-error" role="alert">
              {error}
            </p>
          )}
          <Button type="submit" disabled={pending}>
            {pending ? 'Joining…' : 'Join'}
          </Button>
        </form>
      </Card>
    </main>
  );
}

type HistoryItem =
  | { kind: 'task'; at: number; task: Task }
  | { kind: 'event'; at: number; stamped: StampedEvent };

/** How many history items show before the rest fold away. */
const RECENT_HISTORY = 3;

/** How many facts a card shows before the rest fold away. */
const FACTS_SHOWN = 2;

export function PhoneFeed({ role }: { role: string }) {
  const scenario = useScenario();
  const { events, tasks, rejection, connected, ended, send } = useKaki({ kind: 'role', role });
  const stamped = useStampedEvents(events);

  if (ended !== undefined) {
    return (
      <main className="phone">
        <header className="phone-header">
          <p className="eyebrow">Kaki · {roleLabel(scenario, role)}</p>
          <h1>{scenario.meetingTitle}</h1>
        </header>
        <Card title="This meeting has ended">
          <p className="task-error" role="alert">
            {ended}
          </p>
        </Card>
      </main>
    );
  }

  const allTasks = [...tasks.values()];
  const currentTask = allTasks
    .filter(needsAction)
    .sort((left, right) => updatedAtMs(right) - updatedAtMs(left))[0];

  const nudges = stamped.filter(isStampedNudge);
  const latestNudge = nudges[nudges.length - 1];
  const currentNudge = currentTask === undefined ? latestNudge : undefined;

  const historyTasks = allTasks.filter((task) => task.id !== currentTask?.id);
  const historyEvents = stamped.filter(
    (item) =>
      (item.event.type === 'NUDGE' || item.event.type === 'FACT_FOUND') &&
      (currentNudge === undefined || item.id !== currentNudge.id),
  );

  // The same question or nudge can arrive more than once: keep only the newest copy of each.
  const seenKeys = new Set<string>();
  const dedupedEvents = [...historyEvents].reverse().filter((item) => {
    const key =
      item.event.type === 'FACT_FOUND'
        ? `fact:${item.event.payload.question.trim().toLowerCase()}`
        : item.event.type === 'NUDGE'
          ? `nudge:${item.event.payload.text.trim().toLowerCase()}`
          : `id:${item.id}`;
    if (seenKeys.has(key)) return false;
    seenKeys.add(key);
    return true;
  });

  const history: HistoryItem[] = [
    ...historyTasks.map((task) => ({ kind: 'task' as const, at: updatedAtMs(task), task })),
    ...dedupedEvents.map((stampedEvent) => ({
      kind: 'event' as const,
      at: stampedEvent.receivedAt,
      stamped: stampedEvent,
    })),
  ].sort((left, right) => right.at - left.at);

  const renderHistoryItem = (item: HistoryItem) =>
    item.kind === 'task' ? (
      <li key={`task-${taskKey(item.task)}`}>
        <TaskCard key={taskKey(item.task)} task={item.task} scenario={scenario} send={send} rejection={rejection} />
      </li>
    ) : item.stamped.event.type === 'NUDGE' ? (
      <li key={`event-${item.stamped.id}`}>
        <NudgeCard text={item.stamped.event.payload.text} at={item.at} />
      </li>
    ) : item.stamped.event.type === 'FACT_FOUND' ? (
      <li key={`event-${item.stamped.id}`}>
        <FactCard question={item.stamped.event.payload.question} facts={item.stamped.event.payload.facts} at={item.at} />
      </li>
    ) : null;
  const calm = currentTask === undefined && currentNudge === undefined;

  return (
    <main className="phone">
      <header className="phone-header">
        <p className="eyebrow">Kaki · {roleLabel(scenario, role)}</p>
        <h1>{scenario.meetingTitle}</h1>
      </header>

      {connected ? null : <ConnectionBanner />}
      {rejection === null ? null : (
        <RejectionBanner message={`${rejection.commandType}: ${rejection.reason}`} />
      )}

      <section
        className={calm ? 'phone-current phone-calm' : 'phone-current'}
        aria-label={calm ? 'Status' : 'Needs you now'}
      >
        {currentTask !== undefined ? (
          <>
            <p className="eyebrow phone-section-eyebrow">Needs you now</p>
            <TaskCard
              key={taskKey(currentTask)}
              task={currentTask}
              scenario={scenario}
              send={send}
              rejection={rejection}
            />
          </>
        ) : currentNudge !== undefined ? (
          <>
            <p className="eyebrow phone-section-eyebrow">Needs you now</p>
            <NudgeCard
              text={currentNudge.event.payload.text}
              at={currentNudge.receivedAt}
              prominent
            />
          </>
        ) : (
          <Card>
            <h2 className="card-title">Nothing needs you right now</h2>
            <p className="phone-meta">
              Kaki will nudge you here when your agenda item is coming up.
            </p>
          </Card>
        )}
      </section>

      <section className="phone-history" aria-labelledby="phone-history-title">
        <h2 id="phone-history-title">History</h2>
        {history.length === 0 ? (
          <p className="empty-state">Nothing else yet.</p>
        ) : (
          <>
            <ol className="phone-history-list">{history.slice(0, RECENT_HISTORY).map(renderHistoryItem)}</ol>
            {history.length > RECENT_HISTORY && (
              <details className="phone-more">
                <summary>Earlier · {history.length - RECENT_HISTORY} more</summary>
                <ol className="phone-history-list">{history.slice(RECENT_HISTORY).map(renderHistoryItem)}</ol>
              </details>
            )}
          </>
        )}
      </section>
    </main>
  );
}

const MIN_SENDING_MS = 1200;

/**
 * Shows only the visitor's active task card (when a task assigned to `role` needs action or review)
 * and any latest company-record lookup, without the full PhonePage header, empty state, or history list.
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
 * The server can finish sending in well under a second, so the phone would never show it.
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
              {openLivePlatformLabel(task)}
            </a>
          )}
        </div>
      ) : null}
    </Card>
  );
}

function NudgeCard({ text, at, prominent = false }: { text: string; at: number; prominent?: boolean }) {
  return (
    <Card>
      <div className="phone-item-head">
        <p className="phone-item-kind">Nudge</p>
        <TimeLabel at={at} />
      </div>
      <p className={prominent ? 'phone-current-text' : 'phone-item-text'}>{text}</p>
    </Card>
  );
}

function FactItem({ fact }: { fact: Fact }) {
  return (
    <li className="phone-fact">
      <p className="phone-fact-text">{fact.text}</p>
      <p className="phone-fact-source">
        <span className="chip">{fact.source}</span>
        <span className="chip chip-date">{fact.date}</span>
      </p>
    </li>
  );
}

function FactCard({ question, facts, at }: { question: string; facts: Fact[]; at: number }) {
  const rest = facts.slice(FACTS_SHOWN);
  return (
    <Card>
      <div className="phone-item-head">
        <p className="phone-item-kind">From the company records</p>
        <TimeLabel at={at} />
      </div>
      <h3 className="card-title phone-fact-question">{question}</h3>
      {facts.length === 0 ? (
        <p className="phone-meta">No matching records found.</p>
      ) : (
        <>
          <ul className="phone-facts">
            {facts.slice(0, FACTS_SHOWN).map((fact, index) => (
              <FactItem key={`${fact.source}-${fact.date}-${index}`} fact={fact} />
            ))}
          </ul>
          {rest.length > 0 && (
            <details className="phone-more">
              <summary>{rest.length} more</summary>
              <ul className="phone-facts">
                {rest.map((fact, index) => (
                  <FactItem key={`${fact.source}-${fact.date}-${index}`} fact={fact} />
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </Card>
  );
}
