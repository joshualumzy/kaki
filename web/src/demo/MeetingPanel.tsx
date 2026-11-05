import { useEffect, useMemo, useRef, useState } from 'react';
import { roleLabel, type KakiEvent, type Task } from '@kaki/shared';
import { useKaki, useScenario } from '../kaki';
import { MeetingRecordCard, isRecord, type RecordEvent } from '../screen/ScreenPage';
import type { TranscriptViewer } from './captions';
import { entryForEvent, entryForTask, type TimelineEntry } from './timeline';

/**
 * Everything the room is tracking in one place, like the shared screen: the agenda clock and open questions,
 * then one timeline of what is said, the host's spoken cues and task changes, then the tasks.
 * The socket only keeps its last 50 events, so the timeline keeps its own history.
 */
export function MeetingPanel({ viewer }: { viewer: TranscriptViewer }) {
  const scenario = useScenario();
  const { events, tasks, connected } = useKaki('screen');
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
      const entry = entryForEvent(event, scenario, viewer);
      if (entry !== undefined && !seenKeys.current.has(entry.key)) {
        seenKeys.current.add(entry.key);
        added.push(entry);
      }
    }
    if (added.length > 0) setEntries((previous) => [...previous, ...added]);
  }, [events, scenario, viewer]);

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
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
