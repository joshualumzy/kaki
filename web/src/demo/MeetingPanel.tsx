import { useEffect, useMemo, useRef, useState } from 'react';
import {
  assigneeLabel,
  itemMode,
  roleLabel,
  type AgendaItem,
  type KakiEvent,
  type Role,
  type Scenario,
  type ScenarioRole,
  type Task,
} from '@kaki/shared';
import { useKaki, useScenario } from '../kaki';
import { MeetingRecordCard, isRecord, type RecordEvent } from '../screen/ScreenPage';
import type { TranscriptViewer } from './captions';
import { entryForEvent, entryForTask, type TimelineEntry } from './timeline';

/**
 * Everything the room is tracking in one place: the agenda clock, a quick topic cheat sheet for the
 * current item, the live transcript, and the tasks.
 * The socket only keeps its last 50 events, so the timeline keeps its own history.
 */
export function MeetingPanel({
  viewer,
  role,
  isHost = false,
}: {
  viewer: TranscriptViewer;
  role?: ScenarioRole;
  isHost?: boolean;
}) {
  const scenario = useScenario();
  // The same socket as the shared screen: it is the one allowed to send host commands, so a host here
  // needs auth off or a signed-in host (the page cannot connect otherwise).
  const { events, tasks, connected, rejection, send } = useKaki('screen');
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [record, setRecord] = useState<RecordEvent | undefined>();
  const seenKeys = useRef(new Set<string>());
  const seenEvents = useRef(new WeakSet<KakiEvent>());
  const taskStatus = useRef(new Map<string, Task['status']>());
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const added: TimelineEntry[] = [];
    for (const event of events) {
      if (seenEvents.current.has(event)) continue;
      seenEvents.current.add(event);
      if (isRecord(event)) {
        setRecord(event);
        continue;
      }
      const entry = entryForEvent(event, viewer, isHost, scenario);
      if (entry !== undefined && !seenKeys.current.has(entry.key)) {
        seenKeys.current.add(entry.key);
        added.push(entry);
      }
    }
    if (added.length > 0) setEntries((previous) => [...previous, ...added]);
  }, [events, viewer, isHost, scenario]);

  const screenFacts = useMemo(
    () =>
      events.filter(
        (event): event is Extract<KakiEvent, { type: 'FACT_FOUND' }> =>
          event.type === 'FACT_FOUND' && event.payload.facts.length > 0,
      ),
    [events],
  );
  const latestFact = screenFacts.at(-1);

  useEffect(() => {
    const added: TimelineEntry[] = [];
    for (const task of tasks.values()) {
      const entry = entryForTask(task, taskStatus.current.get(task.id));
      taskStatus.current.set(task.id, task.status);
      if (entry !== undefined && !seenKeys.current.has(entry.key)) {
        seenKeys.current.add(entry.key);
        added.push(entry);
      }
    }
    if (added.length > 0) setEntries((previous) => [...previous, ...added]);
  }, [tasks]);

  const hasActiveVisitorTask = useMemo(
    () =>
      role !== undefined &&
      [...tasks.values()].some(
        (task) =>
          task.assignee === role.id &&
          (task.status === 'DISPATCHED' || task.status === 'DRAFT_READY' || task.status === 'FAILED'),
      ),
    [role, tasks],
  );

  useEffect(() => {
    // Do not yank the dock scroll away from the visitor's active task card at the top when new transcript lines arrive.
    if (hasActiveVisitorTask) return;
    const scrollContainer = end.current?.closest('.kd-dock-body');
    if (scrollContainer instanceof HTMLElement) {
      const distanceFromBottom =
        scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight;
      // Only auto-scroll if the visitor is already near the bottom of the dock (not reading their briefing or a task card at the top).
      if (distanceFromBottom <= 140) {
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
      }
      return;
    }
    end.current?.scrollIntoView?.({ block: 'end' });
  }, [entries.length, hasActiveVisitorTask]);

  const visibleTasks = useMemo(() => [...tasks.values()].filter((task) => task.status !== 'DISMISSED'), [tasks]);
  const minutesTask = useMemo(
    () =>
      visibleTasks.find(
        (task) =>
          task.actionKind === 'wiki_page' &&
          /^Publish meeting minutes/i.test(task.title) &&
          task.artifactUrl !== undefined,
      ),
    [visibleTasks],
  );

  return (
    <div className="page kd-host kd-meeting-panel">
      {!connected && <p className="connection-banner">Reconnecting…</p>}
      {isHost && <HostBrief scenario={scenario} />}
      {isHost && rejection !== null && (
        <p className="connection-banner" role="alert">
          {rejection.commandType}: {rejection.reason}
        </p>
      )}
      {isHost && (
        <div className="kd-host-controls">
          <button type="button" className="kd-chip" disabled={record === undefined} onClick={() => send({ type: 'NEXT_AGENDA_ITEM' })}>
            Next agenda item
          </button>
          <button type="button" className="kd-chip" disabled={record === undefined} onClick={() => send({ type: 'END_MEETING' })}>
            End meeting
          </button>
        </div>
      )}
      {minutesTask?.artifactUrl !== undefined && (
        <section className="kd-role kd-topic-card" aria-label="End-of-meeting minutes">
          <p className="kd-role-eyebrow">Kaki Host · Meeting Minutes Published</p>
          <p style={{ marginBottom: 8 }}>
            Full meeting notes (agenda items, action items, open questions, and transcript) are live on the team wiki.
          </p>
          <a className="artifact-link" href={minutesTask.artifactUrl} target="_blank" rel="noreferrer">
            Open meeting minutes in Wiki ↗
          </a>
        </section>
      )}
      {record === undefined ? (
        <p className="empty-state">The meeting has not started yet. The agenda clock begins with the first thing said.</p>
      ) : (
        <>
          <MeetingRecordCard record={record} scenario={scenario} />
          <CurrentTopicCard
            item={scenario.agenda[record.payload.agendaIndex]}
            scenario={scenario}
            role={role}
            viewer={viewer}
          />
          {latestFact !== undefined && (
            <section className="kd-role kd-topic-card" aria-label="From the company records">
              <p className="kd-role-eyebrow">Kaki Wingman · From the company records</p>
              <p style={{ marginBottom: 6 }}>
                <strong>{latestFact.payload.question}</strong>
              </p>
              <ul style={{ marginBottom: 0 }}>
                {latestFact.payload.facts.slice(0, 3).map((fact, index) => (
                  <li key={`${fact.source}-${fact.date}-${index}`}>
                    {fact.text} <small>({fact.source} · {fact.date})</small>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      <h3 className="eyebrow">Live feed</h3>
      {entries.length === 0 ? (
        <p className="empty-state">Nothing yet.</p>
      ) : (
        <ol className="kd-lines">
          {entries.map((entry) => (
            <li key={entry.key} data-kind={entry.kind}>
              {entry.who !== undefined && <b>{entry.who}</b>}
              <span>{entry.text}</span>
            </li>
          ))}
        </ol>
      )}
      <div ref={end} />

      {visibleTasks.length > 0 && (
        <div className="kd-tasks">
          <h3 className="eyebrow">Tasks</h3>
          <ul>
            {visibleTasks.map((task) => (
              <li key={task.id}>
                <b>{task.title}</b>
                <span>
                  {assigneeLabel(scenario, task.assignee ?? task.suggestedAssignee, viewer)} ·{' '}
                  {taskStatusText(task)}
                </span>
                {task.context.trim() !== '' && <small>{task.context}</small>}
                {task.artifactUrl !== undefined && (task.status === 'COMPLETED' || task.status === 'SYNCED') && (
                  <a className="artifact-link" href={task.artifactUrl} target="_blank" rel="noreferrer">
                    {artifactLinkText(task)}
                  </a>
                )}
                {task.status === 'FAILED' && task.error !== undefined && <small role="alert">{task.error}</small>}
                {isHost && task.status === 'SUGGESTED' && (
                  <TaskControls
                    task={task}
                    scenario={scenario}
                    onDispatch={(assignee) => send({ type: 'DISPATCH_TASK', taskId: task.id, assignee })}
                    onDismiss={() => send({ type: 'DISMISS_TASK', taskId: task.id })}
                  />
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
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

function artifactLinkText(task: Task): string {
  switch (task.actionKind) {
    case 'gitea_issue':
      return 'Open ticket in Gitea ↗';
    case 'mattermost_post':
      return 'Open post in Mattermost ↗';
    case 'wiki_page':
      return 'Open page in Wiki ↗';
    case 'email':
      return 'Open email in Mailpit ↗';
    default:
      return 'Open artifact ↗';
  }
}

/**
 * Compact context card for the current agenda item so the visitor has the decision and any facts
 * from their own role that match this topic right above the transcript.
 */
function CurrentTopicCard({
  item,
  scenario,
  role,
  viewer,
}: {
  item: AgendaItem | undefined;
  scenario: Scenario;
  role: ScenarioRole | undefined;
  viewer: TranscriptViewer;
}) {
  if (item === undefined) return null;
  const mode = itemMode(scenario, item, role?.id);
  const myFacts = relevantFactsForItem(item, role?.card?.facts ?? [], mode === 'involve');
  const roleBadge =
    mode === 'involve'
      ? 'Your item to lead'
      : mode === 'decide'
        ? 'Team needs your call'
        : `Led by ${assigneeLabel(scenario, item.ownerRole, viewer)} · You can listen in or jump in`;

  if (item.decision === undefined && myFacts.length === 0) return null;

  return (
    <section className="kd-role kd-topic-card" aria-label="Current topic context">
      <p className="kd-role-eyebrow">Wingman · {roleBadge}</p>
      {item.decision !== undefined && (
        <p style={{ marginBottom: myFacts.length > 0 ? 6 : 0 }}>
          <strong>{mode === 'observe' ? 'On the table: ' : 'Your call to make: '}</strong>
          {item.decision}
        </p>
      )}
      {myFacts.length > 0 && (
        <ul style={{ marginBottom: 0 }}>
          {myFacts.map((fact) => (
            <li key={fact}>{fact}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

const GENERIC_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'are', 'was', 'were',
  'have', 'has', 'had', 'not', 'but', 'what', 'when', 'who', 'how', 'why', 'where',
  'your', 'you', 'our', 'their', 'they', 'will', 'can', 'just', 'more', 'first',
  'build', 'game', 'launch', 'team', 'time', 'open', 'issue', 'issues', 'before',
]);

/** Pick only the facts from the visitor's own role card that overlap with this agenda item's specific topic words (or all of them when the visitor owns the item). */
function relevantFactsForItem(item: AgendaItem, facts: readonly string[], isOwner: boolean): string[] {
  if (facts.length === 0) return [];
  const text = `${item.title} ${item.decision ?? ''}`.toLowerCase();
  const keywords = (text.match(/[a-z0-9]+/g) ?? []).filter(
    (word) => (word.length >= 4 || /^\d+$/.test(word)) && !GENERIC_WORDS.has(word),
  );
  const matched = facts.filter((fact) => {
    const lower = fact.toLowerCase();
    return keywords.some((word) => new RegExp(`\\b${word}\\b`, 'i').test(lower));
  });
  if (matched.length > 0) return matched;
  return isOwner ? facts.slice(0, 2) : [];
}

/** What the person hosting is told before they start: the goal, the decision to land and the agenda. */
function HostBrief({ scenario }: { scenario: Scenario }) {
  const brief = scenario.hostBrief;
  const host = (scenario.npcs ?? []).find((npc) => npc.role === 'host');
  const goal = brief?.goal ?? host?.agenda;
  if (goal === undefined) return null;
  return (
    <section className="kd-role" aria-label="Your briefing as host">
      <p className="kd-role-eyebrow">You are hosting · {scenario.meetingTitle}</p>
      <p>{goal}</p>
      {brief !== undefined && (
        <p>
          <strong>The decision to land: </strong>
          {brief.decision}
        </p>
      )}
      <ol style={{ margin: 0, paddingLeft: 18 }}>
        {scenario.agenda.map((item) => (
          <li key={item.title}>
            {item.title} · {item.minutes} min · {roleLabel(scenario, item.ownerRole)}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Dispatch a suggested task to a role, or dismiss it. Starts on the role the notetaker suggested. */
function TaskControls({
  task,
  scenario,
  onDispatch,
  onDismiss,
}: {
  task: Task;
  scenario: Scenario;
  onDispatch(assignee: Role): void;
  onDismiss(): void;
}) {
  const [assignee, setAssignee] = useState<Role>(task.suggestedAssignee);
  return (
    <span className="kd-host-controls">
      <select aria-label={`Who should do "${task.title}"`} value={assignee} onChange={(event) => setAssignee(event.target.value as Role)}>
        {scenario.roles.map((role) => (
          <option key={role.id} value={role.id}>
            {assigneeLabel(scenario, role.id)}
          </option>
        ))}
      </select>
      <button type="button" className="kd-chip" onClick={() => onDispatch(assignee)}>
        Dispatch
      </button>
      <button type="button" className="kd-chip" onClick={onDismiss}>
        Dismiss
      </button>
    </span>
  );
}
