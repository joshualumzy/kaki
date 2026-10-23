import { roleLabel, type KakiCommand, type Scenario, type Task } from '@kaki/shared';
import { useKaki, useScenario } from '../kaki';
import {
  Button,
  Card,
  ConnectionBanner,
  EventList,
  RejectionBanner,
  StatusPill,
} from '../ui';

/** Shared screen shell: shows every event and task addressed to the meeting screen. */
export function ScreenPage() {
  const scenario = useScenario();
  const { events, tasks, rejection, connected, send } = useKaki('screen');
  const taskList = [...tasks.values()];

  return (
    <main className="page">
      <header className="page-header">
        <p className="eyebrow">Kaki · Shared Action Panel</p>
        <h1>{scenario.meetingTitle}</h1>
        <p className="page-subtitle">Everything the room is meant to see lands here.</p>
      </header>
      {connected ? null : <ConnectionBanner />}
      {rejection === null ? null : (
        <RejectionBanner message={`${rejection.commandType}: ${rejection.reason}`} />
      )}
      <Card title="Tasks">
        {taskList.length === 0 ? (
          <p className="empty-state">No tasks yet.</p>
        ) : (
          <ul className="event-list">
            {taskList.map((task) => (
              <li key={task.id}>
                <ScreenTask task={task} scenario={scenario} send={send} />
              </li>
            ))}
          </ul>
        )}
      </Card>
      <EventList events={events} />
    </main>
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
    <Card>
      <h2 className="card-title">{task.title}</h2>
      <p className="task-meta">
        <StatusPill status={task.status} /> · {roleLabel(scenario, assignee)}
      </p>
      {task.error === undefined ? null : <p className="task-error">{task.error}</p>}
      {task.status === 'SUGGESTED' ? (
        <div className="task-actions">
          <Button
            onClick={() =>
              send({ type: 'DISPATCH_TASK', taskId: task.id, assignee: task.suggestedAssignee })
            }
          >
            Dispatch to {roleLabel(scenario, task.suggestedAssignee)}
          </Button>
          <Button variant="ghost" onClick={() => send({ type: 'DISMISS_TASK', taskId: task.id })}>
            Dismiss
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
