import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  isRoleIn,
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
import { Button, Card, ConnectionBanner, RejectionBanner, StatusPill } from '../ui';
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
    case 'CLAIMED':
      return true;
    case 'RUNNING':
      return true;
    default:
      return false;
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
    const role = params.get('role');
    if (!isRoleIn(scenario, role)) return <RolePicker />;
    return <PhoneFeed role={role} />;
  }

  const sessionRole = auth.me.kind === 'participant' ? auth.me.role : undefined;
  const role = joinedRole ?? (isRoleIn(scenario, sessionRole) ? sessionRole : undefined);
  if (role !== undefined) return <PhoneFeed role={role} />;

  const requestedRole = params.get('role');
  return (
    <JoinForm
      initialCode={params.get('code') ?? ''}
      initialRole={isRoleIn(scenario, requestedRole) ? requestedRole : ''}
      onJoined={setJoinedRole}
    />
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
          {scenario.roles.map((role) => (
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
  onJoined,
}: {
  initialCode: string;
  initialRole: string;
  onJoined: (role: string) => void;
}) {
  const scenario = useScenario();
  const [code, setCode] = useState(initialCode.toUpperCase());
  const [role, setRole] = useState(initialRole);
  const [error, setError] = useState<string | null>(null);
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
              {scenario.roles.map((scenarioRole) => (
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
  const { events, tasks, rejection, connected, send } = useKaki(role);
  const stamped = useStampedEvents(events);

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

function TaskCard({
  task,
  scenario,
  send,
  rejection,
}: {
  task: Task;
  scenario: Scenario;
  send: (command: KakiCommand) => void;
  rejection: KakiRejection | null;
}) {
  const [body, setBody] = useState(task.draft?.body ?? '');
  const [target, setTarget] = useState(task.draft?.target ?? '');
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const draft = task.draft;

  useEffect(() => {
    if (rejection === null) return;
    busy.current = false;
    setPending(false);
  }, [rejection]);

  function submit(command: KakiCommand): void {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    send(command);
  }

  return (
    <Card>
      <div className="phone-item-head">
        <p className="phone-item-kind">Task</p>
        <TimeLabel at={updatedAtMs(task)} />
      </div>
      <h2 className="card-title phone-task-title">{task.title}</h2>
      <p className="task-meta">
        <StatusPill status={task.status} />
        <span>{roleLabel(scenario, task.assignee ?? task.suggestedAssignee)}</span>
      </p>
      {task.context.trim() === '' ? null : (
        <p className="phone-task-context">{task.context}</p>
      )}
      {task.error === undefined ? null : (
        <p className="task-error" role="alert">
          {task.error}
        </p>
      )}

      {(task.status === 'CLAIMED' && task.mode === 'ACTION_AGENT') || task.status === 'RUNNING' ? (
        <p className="task-meta" role="status" aria-live="polite">
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
              Let Kaki do it
            </Button>
          )}
          <Button
            variant="ghost"
            disabled={pending}
            onClick={() => submit({ type: 'CLAIM_TASK', taskId: task.id, mode: 'MANUAL' })}
          >
            I&apos;ll do it
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
              rows={6}
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
            Approve
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

      {task.status === 'COMPLETED' ? (
        <div className="task-actions" aria-busy={pending}>
          {task.artifactUrl === undefined ? null : (
            <a className="artifact-link" href={task.artifactUrl} target="_blank" rel="noreferrer">
              Open artifact
            </a>
          )}
          <Button disabled={pending} onClick={() => submit({ type: 'SYNC_TASK', taskId: task.id })}>
            Sync to meeting
          </Button>
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
