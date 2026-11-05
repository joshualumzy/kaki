import { useEffect, useMemo, useRef, useState } from 'react';
import { roleLabel, type KakiEvent, type Role, type Scenario, type Task } from '@kaki/shared';
import { useKaki, useScenario } from '../kaki';
import { MeetingRecordCard, isRecord, type RecordEvent } from '../screen/ScreenPage';
import type { TranscriptViewer } from './captions';
import { entryForEvent, entryForTask, type TimelineEntry } from './timeline';

/**
 * Everything the room is tracking in one place, like the shared screen: the agenda clock and open questions,
 * then one timeline of what is said, the host's spoken cues and task changes, then the tasks.
 * The socket only keeps its last 50 events, so the timeline keeps its own history.
 */
export function MeetingPanel({ viewer, isHost = false }: { viewer: TranscriptViewer; isHost?: boolean }) {
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
      const entry = entryForEvent(event, scenario, viewer, isHost);
      if (entry !== undefined && !seenKeys.current.has(entry.key)) {
        seenKeys.current.add(entry.key);
        added.push(entry);
      }
    }
    if (added.length > 0) setEntries((previous) => [...previous, ...added]);
  }, [events, scenario, viewer, isHost]);

  useEffect(() => {
    const added: TimelineEntry[] = [];
    for (const task of tasks.values()) {
      const entry = entryForTask(task, taskStatus.current.get(task.id), scenario);
      taskStatus.current.set(task.id, task.status);
      if (entry !== undefined && !seenKeys.current.has(entry.key)) {
        seenKeys.current.add(entry.key);
        added.push(entry);
      }
    }
    if (added.length > 0) setEntries((previous) => [...previous, ...added]);
  }, [tasks, scenario]);

  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' });
  }, [entries.length]);

  const visibleTasks = useMemo(() => [...tasks.values()].filter((task) => task.status !== 'DISMISSED'), [tasks]);

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
      {record === undefined ? (
        <p className="empty-state">The meeting has not started yet. The agenda clock begins with the first thing said.</p>
      ) : (
        <MeetingRecordCard record={record} scenario={scenario} />
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
                  {roleLabel(scenario, task.assignee ?? task.suggestedAssignee)} · {task.status.replace('_', ' ').toLowerCase()}
                </span>
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
            {role.label}
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
