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
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const seenKeys = useRef(new Set<string>());
  const seenEvents = useRef(new WeakSet<KakiEvent>());
  const taskStatus = useRef(new Map<string, Task['status']>());
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (events.length === 0 || (events.length === 1 && events[0]?.type === 'TRANSCRIPT_CHUNK')) {
      setEntries([]);
      setRecord(undefined);
      seenKeys.current.clear();
      taskStatus.current.clear();
    }
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

  const facilitatorName = useMemo(() => {
    const hostRole = scenario.roles.find((r) => r.facilitator === true);
    return scenario.attendees.find((a) => a.role === hostRole?.id)?.name ?? 'Sam';
  }, [scenario]);

  const topicBriefingStarted = useMemo(() => {
    if (record !== undefined && record.payload.elapsedSeconds >= 22) return true;
    return events.some(
      (event) =>
        event.type === 'TRANSCRIPT_CHUNK' &&
        !event.payload.speaker.startsWith(facilitatorName),
    );
  }, [events, facilitatorName, record]);

  const screenFacts = useMemo(
    () =>
      events.filter(
        (event): event is Extract<KakiEvent, { type: 'FACT_FOUND' }> =>
          event.type === 'FACT_FOUND' && event.payload.facts.length > 0,
      ),
    [events],
  );
  const latestFact = topicBriefingStarted ? screenFacts.at(-1) : undefined;

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
          (task.status === 'DISPATCHED' ||
            task.status === 'CLAIMED' ||
            task.status === 'DRAFT_READY' ||
            task.status === 'RUNNING' ||
            task.status === 'COMPLETED' ||
            task.status === 'FAILED'),
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
  const boardTasks = useMemo(
    () =>
      visibleTasks.filter(
        (task) =>
          !(
            role !== undefined &&
            task.assignee === role.id &&
            (task.status === 'DISPATCHED' ||
              task.status === 'CLAIMED' ||
              task.status === 'DRAFT_READY' ||
              task.status === 'RUNNING' ||
              task.status === 'COMPLETED' ||
              task.status === 'FAILED')
          ),
      ),
    [visibleTasks, role],
  );
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
  const meetingEnded = useMemo(
    () =>
      minutesTask !== undefined ||
      events.some((event) => event.type === 'HOST_SPEECH_TRIGGERED' && event.payload.kind === 'CLOSING'),
    [events, minutesTask],
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
          <button type="button" className="kd-chip" disabled={record === undefined || meetingEnded} onClick={() => send({ type: 'NEXT_AGENDA_ITEM' })}>
            Next agenda item
          </button>
          <button type="button" className="kd-chip" disabled={record === undefined || meetingEnded} onClick={() => send({ type: 'END_MEETING' })}>
            End meeting
          </button>
        </div>
      )}
      {meetingEnded && (
        <section className="kd-role kd-topic-card" aria-label="End-of-meeting minutes">
          <p className="kd-role-eyebrow">
            {minutesTask?.artifactUrl !== undefined
              ? 'Kaki Host · Meeting Minutes Published'
              : 'Kaki Host · Meeting Concluded'}
          </p>
          <p style={{ marginBottom: 10 }}>
            {minutesTask?.artifactUrl !== undefined
              ? 'Full meeting notes (agenda items, action items, open questions, and transcript) are live on the team wiki.'
              : 'Syncing final action items and publishing meeting minutes to the team wiki…'}
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            {minutesTask?.artifactUrl !== undefined && (
              <a className="artifact-link" href={minutesTask.artifactUrl} target="_blank" rel="noreferrer">
                Open meeting minutes in Wiki ↗
              </a>
            )}
            <button
              type="button"
              className="kd-chip"
              onClick={() => window.location.reload()}
            >
              Start new meeting / Switch role
            </button>
          </div>
        </section>
      )}
      {record === undefined ? (
        <>
          {isHost && <HostCueCard scenario={scenario} agendaIndex={0} started={false} />}
          <p className="empty-state">The meeting has not started yet. The agenda clock begins with the first thing said.</p>
        </>
      ) : (
        <>
          <MeetingRecordCard record={record} scenario={scenario} ended={meetingEnded} />
          {!meetingEnded && isHost && (
            <HostCueCard scenario={scenario} agendaIndex={record.payload.agendaIndex} started />
          )}
          {!meetingEnded && topicBriefingStarted && (
            <CurrentTopicCard
              item={scenario.agenda[record.payload.agendaIndex]}
              scenario={scenario}
              role={role}
              viewer={viewer}
            />
          )}
          {(() => {
            if (latestFact === undefined) return null;
            const currentItem = scenario.agenda[record.payload.agendaIndex];
            const myFacts =
              currentItem !== undefined
                ? relevantFactsForItem(
                    currentItem,
                    role?.card?.facts ?? [],
                    itemMode(scenario, currentItem, role?.id) === 'involve',
                  )
                : [];
            const nonDuplicateFacts = filterNonDuplicateCompanyFacts(latestFact.payload.facts, myFacts);
            if (nonDuplicateFacts.length === 0) return null;
            return (
              <section className="kd-role kd-topic-card" aria-label="From the company records">
                <p className="kd-role-eyebrow">Kaki Wingman · From the company records</p>
                <p style={{ marginBottom: 6 }}>
                  <strong>{latestFact.payload.question}</strong>
                </p>
                <ul className="kd-record-list" style={{ marginBottom: 0 }}>
                  {nonDuplicateFacts.slice(0, 3).map((fact, index) => (
                    <li key={`${fact.source}-${fact.date}-${index}`}>
                      <span className="kd-record-source-pill">{sourceBadgeText(fact.source)}</span>
                      <span>{fact.text}</span>
                      <small>({fact.source} · {fact.date})</small>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })()}
        </>
      )}

      {boardTasks.length > 0 && (
        <div className="kd-tasks">
          <h3 className="eyebrow">Live Kaki Actions ({boardTasks.length})</h3>
          <ul>
            {boardTasks.map((task) => (
              <li key={task.id} className="kd-task-card" data-status={task.status}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                  <b style={{ flex: 1, minWidth: 0 }}>{task.title}</b>
                  <span style={{ display: 'flex', gap: 4, flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    {actionKindBadge(task) !== undefined && (
                      <span className="kd-task-badge">{actionKindBadge(task)}</span>
                    )}
                    <span className="kd-task-badge">{taskStatusText(task)}</span>
                  </span>
                </div>
                <span>
                  Owner: {assigneeLabel(scenario, task.assignee ?? task.suggestedAssignee, viewer)}
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

      <details
        className="kd-briefing kd-transcript-drawer"
        open={transcriptOpen}
        onToggle={(event) => setTranscriptOpen(event.currentTarget.open)}
      >
        <summary className="kd-briefing-summary">
          <span>
            Live transcript ({entries.length})
            {!transcriptOpen && entries.at(-1) !== undefined && (
              <small style={{ marginLeft: 8, opacity: 0.75, fontWeight: 400 }}>
                · {entries.at(-1)?.who ? `${entries.at(-1)?.who}: ` : ''}
                {(entries.at(-1)?.text ?? '').slice(0, 48)}
                {(entries.at(-1)?.text.length ?? 0) > 48 ? '…' : ''}
              </small>
            )}
          </span>
          <span className="kd-briefing-toggle">{transcriptOpen ? 'Hide' : 'Show'}</span>
        </summary>
        {entries.length === 0 ? (
          <p className="empty-state" style={{ marginTop: 8 }}>Nothing yet.</p>
        ) : (
          <ol className="kd-lines" style={{ marginTop: 10 }}>
            {entries.map((entry) => (
              <li key={entry.key} data-kind={entry.kind}>
                {entry.who !== undefined && <b>{entry.who}</b>}
                <span>{entry.text}</span>
              </li>
            ))}
          </ol>
        )}
        <div ref={end} />
      </details>
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

function sourceBadgeText(source: string): string {
  const lower = source.toLowerCase();
  if (lower.includes('gitea') || lower.includes('issue') || lower.includes('ticket')) return '🐛 Gitea Ticket';
  if (lower.includes('mattermost') || lower.includes('chat') || lower.includes('channel')) return '💬 Team Chat';
  if (lower.includes('wiki') || lower.includes('sop') || lower.includes('doc') || lower.includes('guide')) return '📖 Wiki SOP';
  if (lower.includes('mail') || lower.includes('email')) return '📧 Email';
  if (lower.includes('sql') || lower.includes('postgres') || lower.includes('table')) return '📊 Store DB';
  return '📁 Record';
}

function actionKindBadge(task: Task): string | undefined {
  switch (task.actionKind) {
    case 'gitea_issue':
      return 'Gitea';
    case 'mattermost_post':
      return 'Mattermost';
    case 'wiki_page':
      return 'Wiki';
    case 'email':
      return 'Mailpit';
    case 'calendar_event':
      return 'Calendar';
    default:
      return undefined;
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
        <p style={{ marginBottom: myFacts.length > 0 ? 8 : 0 }}>
          <strong>{mode === 'observe' ? 'On the table: ' : 'Your call to make: '}</strong>
          {item.decision}
        </p>
      )}
      {myFacts.length > 0 && (
        <div className="kd-fact-chips" aria-label="Key facts for this topic">
          {myFacts.map((fact) => (
            <div key={fact} className="kd-fact-chip">
              {fact}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** Live cue card for a visitor playing the Host seat so they know who to call on and what to land on each agenda item. */
function HostCueCard({
  scenario,
  agendaIndex,
  started,
}: {
  scenario: Scenario;
  agendaIndex: number;
  started: boolean;
}) {
  const item = scenario.agenda[agendaIndex] ?? scenario.agenda[0];
  if (item === undefined) return null;
  const ownerAttendee = scenario.attendees.find((a) => a.role === item.ownerRole)?.name ?? roleLabel(scenario, item.ownerRole);
  const coHostAttendee = scenario.attendees.find((a) => a.role === 'producer')?.name ?? 'Wei Ling';
  return (
    <section className="kd-role kd-topic-card" aria-label="Host cue card">
      <p className="kd-role-eyebrow">Kaki Wingman · Host Cue Card (Item {agendaIndex + 1} of {scenario.agenda.length})</p>
      <p style={{ marginBottom: 6 }}>
        <strong>{started ? `Now chairing: ${item.title}` : `How to kick off Item 1: ${item.title}`}</strong>
      </p>
      <p style={{ marginBottom: 6 }}>
        Try saying: <em>&ldquo;Hey team, let&rsquo;s start with {item.title}. {ownerAttendee}, can you walk us through it?&rdquo;</em>
      </p>
      <small style={{ display: 'block', opacity: 0.85 }}>
        Tip: {coHostAttendee} (Operations Director) will help co-host if the room goes quiet, or you can click <b>Next agenda item</b> above anytime.
      </small>
    </section>
  );
}

const GENERIC_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'are', 'was', 'were',
  'have', 'has', 'had', 'not', 'but', 'what', 'when', 'who', 'how', 'why', 'where',
  'your', 'you', 'our', 'their', 'they', 'will', 'can', 'just', 'more', 'first',
  'build', 'game', 'launch', 'team', 'time', 'open', 'issue', 'issues', 'before',
  'order', 'morning', 'counter', 'kiosk', 'kiosks', 'toast', 'staff', 'regulars',
  'customers', 'handle', 'without', 'make', 'keep', 'turn', 'turned', 'away',
]);

/** Pick only the single most relevant fact from the visitor's own role card that matches this agenda item's specific topic words. */
function relevantFactsForItem(item: AgendaItem, facts: readonly string[], isOwner: boolean): string[] {
  if (facts.length === 0) return [];
  const text = `${item.title} ${item.decision ?? ''}`.toLowerCase();
  const keywords = (text.match(/[a-z0-9]+/g) ?? []).filter(
    (word) => (word.length >= 4 || /^\d+$/.test(word)) && !GENERIC_WORDS.has(word),
  );
  if (keywords.length > 0) {
    const scored = facts
      .map((fact) => {
        const lower = fact.toLowerCase();
        const hits = keywords.filter((word) => new RegExp(`\\b${word}\\b`, 'i').test(lower)).length;
        return { fact, hits };
      })
      .filter((entry) => entry.hits > 0)
      .sort((a, b) => b.hits - a.hits);
    if (scored.length > 0) {
      return [scored[0]!.fact];
    }
  }
  return isOwner ? facts.slice(0, 1) : [];
}

/** Drop company-record bullets that merely repeat the visitor's own role-card fact shown right above in "Your call to make". */
function filterNonDuplicateCompanyFacts<T extends { text: string }>(
  companyFacts: readonly T[],
  myRoleFacts: readonly string[],
): T[] {
  if (myRoleFacts.length === 0 || companyFacts.length <= 1) return [...companyFacts];
  const roleTokens = new Set(
    myRoleFacts
      .join(' ')
      .toLowerCase()
      .replace(/,/g, '')
      .match(/[a-z0-9]{3,}/g) ?? [],
  );
  const filtered = companyFacts.filter((entry) => {
    const clean = entry.text.toLowerCase().replace(/,/g, '');
    // If both the role card and the company record cite the same specific numbers (e.g. "35" and "1100"), it's a duplicate of their own card.
    const numbers = clean.match(/\b\d{2,}\b/g) ?? [];
    const sharedNumbers = numbers.filter((num) => roleTokens.has(num));
    if (sharedNumbers.length >= 2) return false;
    const words = (clean.match(/[a-z0-9]{4,}/g) ?? []).filter((w) => !GENERIC_WORDS.has(w));
    if (words.length === 0) return true;
    const overlap = words.filter((w) => roleTokens.has(w)).length / words.length;
    return overlap < 0.55;
  });
  return filtered.length > 0 ? filtered : companyFacts.slice(0, 2);
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
