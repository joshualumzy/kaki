import { useEffect, useRef } from 'react';
import { roleLabel, type Task } from '@kaki/shared';
import { useKaki, useScenario } from '../kaki';
import { speakerLabel, transcriptChunks, type TranscriptViewer } from './captions';

/** Everything said so far, newest at the bottom, so the visitor can follow the meeting as it goes. */
export function TranscriptPanel({ viewer }: { viewer: TranscriptViewer }) {
  const { events, connected } = useKaki('screen');
  const lines = transcriptChunks(events, 200);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' });
  }, [lines.length]);

  return (
    <div className="page kd-transcript">
      {!connected && <p className="connection-banner">Reconnecting…</p>}
      {lines.length === 0 ? (
        <p className="empty-state">Nothing has been said yet.</p>
      ) : (
        <ol className="kd-lines">
          {lines.map((line, index) => (
            <li key={`${line.payload.timestamp}-${index}`}>
              <b>{speakerLabel(line.payload.speaker, viewer)}</b>
              <span>{line.payload.text}</span>
            </li>
          ))}
        </ol>
      )}
      <div ref={end} />
    </div>
  );
}

/** The tasks the room is tracking, read-only: who has what and how far along it is. */
export function TaskList() {
  const scenario = useScenario();
  const { tasks } = useKaki('screen');
  const visible = [...tasks.values()].filter((task: Task) => task.status !== 'DISMISSED');
  if (visible.length === 0) return null;
  return (
    <div className="page kd-tasks">
      <h3 className="eyebrow">Tasks</h3>
      <ul>
        {visible.map((task) => (
          <li key={task.id}>
            <b>{task.title}</b>
            <span>
              {roleLabel(scenario, task.assignee ?? task.suggestedAssignee)} · {task.status.replace('_', ' ').toLowerCase()}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
