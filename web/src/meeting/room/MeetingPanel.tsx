import { useEffect, useMemo, useRef, useState } from 'react';
import {
  assigneeLabel,
  roleLabel,
  type KakiEvent,
  type ScenarioRole,
  type Task,
} from '@kaki/shared';
import { useKaki, useScenario } from '../../kaki';
import { RealEndedPanel } from './RealRoomOverlays';
import { useRealRoom } from './realRoom';
import { clearAllStoredJoins } from './rejoinSession';
import { Avatar, artifactLinkText, resolveArtifactUrl, taskStatusText } from '../../ui';
import { MeetingRecordCard, isRecord, type RecordEvent } from './MeetingRecordCard';
import { CurrentTopicCard } from './CurrentTopicCard';
import { HostBrief } from './HostBrief';
import { HostCueCard } from './HostCueCard';
import { TaskControls } from './TaskControls';
import { WingmanPanel } from './WingmanPanel';
import type { TranscriptViewer } from './captions';
import { entryForEvent, entryForTask, type TimelineEntry } from './timeline';

function downloadMinutes(title: string, body: string): void {
  const blob = new Blob([body], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${title.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'meeting-notes'}.md`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * Everything the room is tracking in one place: the agenda clock, a quick topic cheat sheet for the
 * current item, the live transcript, and the tasks.
 * The socket only keeps its last 50 events, so the timeline keeps its own history.
 */
export function MeetingPanel({
  viewer,
  role,
  isHost = false,
  started = false,
  sharedAudience = 'screen',
  practice = false,
  real = false,
  onWingmanBadgeChange,
}: {
  viewer: TranscriptViewer;
  role?: ScenarioRole;
  isHost?: boolean;
  started?: boolean;
  sharedAudience?: 'screen' | 'participant';
  /** A practice meeting keeps the pack's host story; a team meeting briefs on its own plan. */
  practice?: boolean;
  /** A real meeting's End lives in the room bar only, and an empty agenda has nothing to advance. */
  real?: boolean;
  /** Reports the quiet Wingman note count so the room can show it on the Wingman button. */
  onWingmanBadgeChange?(count: number): void;
}) {
  const scenario = useScenario();
  const realRoom = useRealRoom();
  /** Practice meetings have AI colleagues; a team meeting is people only, so its briefing must stay silent. */
  const hasAiColleagues = (scenario.npcs ?? []).length > 0;
  // The same socket as the shared screen: it is the one allowed to send host commands, so a host here
  // needs auth off or a signed-in host (the page cannot connect otherwise).
  const {
    events,
    tasks,
    connected,
    rejection,
    rejections,
    send,
    speechByTopic,
    meetingState,
    wingmanNotes,
    askWingman,
  } = useKaki(sharedAudience === 'participant' ? { kind: 'participant' } : { kind: 'screen' });
  // Only the person the server authorises to drive the shared screen may advance or end the meeting.
  // Everyone else gets no controls at all, rather than controls the server refuses.
  const canControlMeeting = sharedAudience === 'screen';
  // Task dispatch and dismissal ride the same screen authority, minus practice: the server refuses
  // a practice visitor's dispatch, so the buttons must never appear for one.
  const canDecideTasks = canControlMeeting && !practice;
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [record, setRecord] = useState<RecordEvent | undefined>();
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [minutesCopyNote, setMinutesCopyNote] = useState<string | null>(null);
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
    const updated = new Map<string, TimelineEntry>();
    for (const event of events) {
      if (seenEvents.current.has(event)) continue;
      seenEvents.current.add(event);
      if (isRecord(event)) {
        setRecord(event);
        continue;
      }
      const entry = entryForEvent(event, viewer, isHost, scenario);
      if (entry === undefined) continue;
      if (seenKeys.current.has(entry.key)) {
        updated.set(entry.key, entry);
        continue;
      }
      seenKeys.current.add(entry.key);
      added.push(entry);
    }
    if (added.length > 0 || updated.size > 0) {
      setEntries((previous) => {
        const next = updated.size === 0
          ? previous
          : previous.map((entry) => {
              const replacement = updated.get(entry.key);
              return replacement === undefined || replacement.text === entry.text ? entry : replacement;
            });
        return added.length === 0 ? next : [...next, ...added];
      });
    }
  }, [events, viewer, isHost, scenario]);

  const facilitatorName = useMemo(() => {
    const hostRole = scenario.roles.find((r) => r.facilitator === true);
    if (hostRole === undefined) return 'the host';
    return scenario.attendees.find((a) => a.role === hostRole.id)?.name ?? roleLabel(scenario, hostRole.id);
  }, [scenario]);

  // Who spoke on each topic is recorded by the hook as lines arrive, so it survives the record
  // leaving the 50-event window (same source as MeetingGrid).
  const facilitatorRole = useMemo(() => scenario.roles.find((r) => r.facilitator === true)?.id, [scenario]);
  const topicBriefingStarted = useMemo(() => {
    const speech = speechByTopic.get(record?.payload.agendaIndex ?? 0);
    if (speech === undefined) return false;
    for (const speakerRole of speech.roles) {
      if (speakerRole !== facilitatorRole) return true;
    }
    const facilitator = facilitatorName.toLowerCase();
    for (const speaker of speech.names) {
      if (!speaker.startsWith(facilitator)) return true;
    }
    return false;
  }, [speechByTopic, facilitatorRole, facilitatorName, record]);

  const askRejection = useMemo(
    () => [...rejections].reverse().find((item) => item.commandType === 'ASK_WINGMAN') ?? null,
    [rejections],
  );

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

  const peopleBySeat = useMemo(() => {
    const map = new Map<string, { displayName: string; photoUrl: string | null }>();
    for (const person of meetingState?.participants ?? []) {
      map.set(person.seat.trim().toLowerCase(), {
        displayName: person.displayName || person.name,
        photoUrl: person.photoUrl,
      });
    }
    return map;
  }, [meetingState?.participants]);
  const visibleTasks = useMemo(
    () => [...tasks.values()].filter((task) => task.status !== 'DISMISSED' && task.status !== 'SUPERSEDED'),
    [tasks],
  );
  const minutesTask = useMemo(
    () => visibleTasks.find((task) => task.purpose === 'meeting_minutes'),
    [visibleTasks],
  );
  const minutesPublished =
    minutesTask?.artifactUrl !== undefined &&
    (minutesTask.status === 'COMPLETED' || minutesTask.status === 'SYNCED');
  const meetingEnded = useMemo(
    () =>
      minutesTask !== undefined ||
      record?.payload.ended === true ||
      events.some((event) => event.type === 'HOST_SPEECH_TRIGGERED' && event.payload.kind === 'CLOSING'),
    [events, minutesTask, record],
  );
  const currentAgendaTitle = record !== undefined ? scenario.agenda[record.payload.agendaIndex]?.title : undefined;
  const boardTasks = useMemo(
    () =>
      visibleTasks.filter((task) => {
        if (role === undefined || task.assignee !== role.id) return true;
        if (
          task.status === 'DISPATCHED' ||
          task.status === 'CLAIMED' ||
          task.status === 'DRAFT_READY' ||
          task.status === 'RUNNING' ||
          task.status === 'COMPLETED' ||
          task.status === 'FAILED'
        ) {
          return false;
        }
        if (
          task.status === 'SYNCED' &&
          task.artifactUrl !== undefined &&
          !meetingEnded &&
          (currentAgendaTitle === undefined ||
            task.agendaItemTitle === undefined ||
            task.agendaItemTitle === currentAgendaTitle)
        ) {
          return false;
        }
        return true;
      }),
    [visibleTasks, role, meetingEnded, currentAgendaTitle],
  );
  const publishedDeliverables = useMemo(
    () =>
      visibleTasks.filter(
        (task) =>
          (task.status === 'COMPLETED' || task.status === 'SYNCED') &&
          task.artifactUrl !== undefined &&
          task.id !== minutesTask?.id,
      ),
    [visibleTasks, minutesTask],
  );

  return (
    <div className="page kd-host kd-meeting-panel">
      {!connected && <p className="connection-banner">Reconnecting…</p>}
      {real && realRoom !== null && !realRoom.isHost && (
        <div className="kd-guest-context" aria-label="About this meeting">
          <b>{scenario.meetingTitle}</b>
          {meetingState?.ownerName ? <small>Hosted by {meetingState.ownerName}</small> : null}
        </div>
      )}
      {isHost && <HostBrief scenario={scenario} practice={practice} />}
      {rejection !== null && rejection.commandType !== 'ASK_WINGMAN' && (
        <p className="connection-banner" role="alert">
          {rejection.commandType}: {rejection.reason}
        </p>
      )}
      {role !== undefined && (
        <WingmanPanel
          notes={wingmanNotes}
          onAsk={askWingman}
          onDismiss={(id) => send({ type: 'DISMISS_WINGMAN_NOTE', id })}
          askRejection={askRejection}
          {...(onWingmanBadgeChange === undefined ? {} : { onQuietCountChange: onWingmanBadgeChange })}
        />
      )}
      {canControlMeeting && (
        <div className="kd-host-controls">
          {scenario.agenda.length > 0 && (
            <button
              type="button"
              className="kd-chip"
              disabled={
                record === undefined ||
                meetingEnded ||
                record.payload.agendaIndex + 1 >= scenario.agenda.length
              }
              onClick={() => send({ type: 'NEXT_AGENDA_ITEM' })}
            >
              Next agenda item
            </button>
          )}
          {!real && (
            <button type="button" className="kd-chip" disabled={record === undefined || meetingEnded} onClick={() => send({ type: 'END_MEETING' })}>
              End meeting
            </button>
          )}
        </div>
      )}
      {real && <RealEndedPanel meetingId={realRoom?.meetingId ?? ''} />}
      {meetingEnded && !real && (
        <section id="minutes" className="kd-role kd-topic-card" aria-label="End-of-meeting minutes">
          <p className="kd-role-eyebrow">
            {minutesPublished
              ? '🎉 Kaki Host · Meeting Minutes & Live Artifacts Ready'
              : minutesTask === undefined
                ? '🎉 Kaki Host · Meeting Concluded'
                : '📝 Kaki Host · Meeting Minutes Draft'}
          </p>
          <p style={{ marginBottom: 10 }}>
            {minutesPublished
              ? 'Full meeting notes (agenda items, action items, open questions, and transcript) and your team deliverables are live:'
              : minutesTask === undefined
                ? 'Syncing final action items and preparing the meeting minutes draft…'
                : minutesTask.status === 'RUNNING'
                  ? 'The approved minutes are being published now.'
                  : minutesTask.status === 'FAILED' || minutesTask.error !== undefined
                    ? 'The meeting minutes could not be prepared.'
                    : minutesTask.status === 'DRAFT_READY'
                      ? 'Minutes draft ready for review.'
                      : 'Preparing the minutes draft…'}
          </p>
          {minutesTask !== undefined && !minutesPublished && (() => {
            const assignee = minutesTask.assignee ?? minutesTask.suggestedAssignee;
            const label = assigneeLabel(scenario, assignee, viewer);
            const person = assignee === undefined ? undefined : peopleBySeat.get(assignee.trim().toLowerCase());
            return (
              <p style={{ marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
                <Avatar name={person?.displayName ?? label} photoUrl={person?.photoUrl} size="sm" />
                <span>Assigned to {label}.</span>
              </p>
            );
          })()}
          {minutesTask?.error !== undefined && (
            <p role="alert" className="kd-alert">
              {minutesTask.error}
            </p>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            {minutesPublished && minutesTask?.artifactUrl !== undefined && (
              <a className="artifact-link" href={resolveArtifactUrl(minutesTask.artifactUrl, minutesTask.actionKind)} target="_blank" rel="noreferrer">
                Open meeting minutes in Wiki ↗
              </a>
            )}
            {minutesTask !== undefined && !minutesPublished && role?.id !== undefined &&
              (minutesTask.assignee ?? minutesTask.suggestedAssignee) === role.id && (
                <a className="artifact-link" href={`#task-${minutesTask.id}`}>
                  Open the minutes draft to review ↓
                </a>
              )}
            {publishedDeliverables.map((task) => (
              <a
                key={task.id}
                className="artifact-link"
                href={resolveArtifactUrl(task.artifactUrl!, task.actionKind)}
                target="_blank"
                rel="noreferrer"
              >
                {artifactLinkText(task)}
              </a>
            ))}
            {minutesTask?.draft?.body !== undefined && (
              <>
                <button
                  type="button"
                  className="kd-chip"
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(minutesTask.draft!.body)
                      .then(() => setMinutesCopyNote('Minutes copied.'))
                      .catch(() => setMinutesCopyNote('Could not copy automatically. Select the minutes to copy them.'));
                  }}
                >
                  Copy minutes
                </button>
                <button
                  type="button"
                  className="kd-chip"
                  onClick={() => downloadMinutes(minutesTask.draft!.subject, minutesTask.draft!.body)}
                >
                  Download markdown
                </button>
              </>
            )}
            <button
              type="button"
              className="kd-chip"
              onClick={() => {
                clearAllStoredJoins();
                window.location.reload();
              }}
            >
              Start new meeting / Switch role
            </button>
          </div>
          {minutesCopyNote === null ? null : (
            <p className="task-meta" role="status">{minutesCopyNote}</p>
          )}
        </section>
      )}
      {record === undefined ? (
        <>
          {isHost && <HostCueCard scenario={scenario} agendaIndex={0} started={false} canAdvance={canControlMeeting} />}
          <p className="empty-state">
            {real
              ? meetingState?.waitingForOwner === true
                ? `Waiting for ${meetingState.ownerName?.trim() || 'the owner'} to start.`
                : 'Nothing has been said yet. The notes begin with the first thing said.'
              : started
              ? `🎙️ ${facilitatorName} (Host) is opening the meeting — listen in, Kaki will cue you when it’s your turn.`
              : 'The meeting has not started yet. The agenda clock begins with the first thing said.'}
          </p>
        </>
      ) : (
        <>
          <MeetingRecordCard
            record={record}
            scenario={scenario}
            ended={meetingEnded}
            showOpenQuestions={meetingEnded}
            hideWhenEmptyAgenda={real}
          />
          {!meetingEnded && isHost && (
            <HostCueCard scenario={scenario} agendaIndex={record.payload.agendaIndex} started canAdvance={canControlMeeting} />
          )}
          {!meetingEnded && hasAiColleagues && !topicBriefingStarted && (
            <p className="empty-state" style={{ margin: '6px 0', fontSize: 12.5 }}>
              🎧 Colleagues are sharing their opening stances — the discussion will appear in a moment.
            </p>
          )}
          {!meetingEnded && topicBriefingStarted && (
            <CurrentTopicCard
              item={scenario.agenda[record.payload.agendaIndex]}
              scenario={scenario}
              role={role}
              viewer={viewer}
              events={events}
              agendaIndex={record.payload.agendaIndex}
            />
          )}
        </>
      )}

      {boardTasks.length > 0 && (
        <div className="kd-tasks">
          <h3 className="eyebrow">Team Action Board ({boardTasks.length})</h3>
          <ul>
            {boardTasks.map((task) => (
              <li
                key={task.id}
                className="kd-task-card"
                data-status={task.status}
                data-highlight={
                  (canDecideTasks && task.status === 'SUGGESTED') ||
                  ((task.status === 'COMPLETED' || task.status === 'SYNCED') && task.artifactUrl !== undefined)
                    ? 'true'
                    : undefined
                }
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                  <b style={{ flex: 1, minWidth: 0 }}>{task.title}</b>
                  <span style={{ display: 'flex', gap: 4, flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    {actionKindBadge(task) !== undefined && (
                      <span className="kd-task-badge">{actionKindBadge(task)}</span>
                    )}
                    <span className="kd-task-badge">{taskStatusText(task, { unresolvedSuggested: true })}</span>
                  </span>
                </div>
                <span>
                  Owner: {assigneeLabel(scenario, task.assignee ?? task.suggestedAssignee, viewer)}
                </span>
                {(() => {
                  const owner = task.assignee ?? task.suggestedAssignee;
                  const seat = (role?.id ?? viewer.seatName)?.trim().toLowerCase();
                  const offersAction =
                    task.fit?.status === 'ready' || (task.fit === undefined && task.actionKind !== undefined);
                  if (!offersAction || seat === undefined || owner === undefined || seat === owner.trim().toLowerCase()) {
                    return null;
                  }
                  return (
                    <small className="kd-task-owner-note">
                      Only {assigneeLabel(scenario, owner, viewer)} can send this.
                    </small>
                  );
                })()}
                {task.context.trim() !== '' && <small>{task.context}</small>}
                {task.decisionSource !== undefined && (
                  <small className="kd-task-decision">Accepted decision: {task.decisionSource}</small>
                )}
                {task.artifactUrl !== undefined && (task.status === 'COMPLETED' || task.status === 'SYNCED') && (
                  <a className="artifact-link" href={resolveArtifactUrl(task.artifactUrl, task.actionKind)} target="_blank" rel="noreferrer">
                    {artifactLinkText(task)}
                  </a>
                )}
                {task.error !== undefined && <small role="alert">{task.error}</small>}
                {canDecideTasks && task.status === 'SUGGESTED' && (
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
