import { useEffect, useState } from 'react';
import { isRoleIn, roleLabel, type KakiCommand, type Scenario, type Task } from '@kaki/shared';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useKaki, useScenario } from '../kaki';
import {
  Button,
  Card,
  ConnectionBanner,
  EventList,
  RejectionBanner,
  StatusPill,
} from '../ui';

/** Phone shell: asks for a role when it has none, then shows only that role's events and tasks. */
export function PhonePage() {
  const scenario = useScenario();
  const [params] = useSearchParams();
  const role = params.get('role');

  if (!isRoleIn(scenario, role)) return <RolePicker />;
  return <PhoneFeed role={role} />;
}

function RolePicker() {
  const scenario = useScenario();
  const navigate = useNavigate();

  return (
    <main className="page">
      <header className="page-header">
        <p className="eyebrow">Kaki · Your phone</p>
        <h1>Who are you?</h1>
        <p className="page-subtitle">Pick your meeting role to open your private panel.</p>
      </header>
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

function PhoneFeed({ role }: { role: string }) {
  const scenario = useScenario();
  const { events, tasks, rejection, connected, send } = useKaki(role);
  const taskList = [...tasks.values()];

  return (
    <main className="page">
      <header className="page-header">
        <p className="eyebrow">Kaki · {roleLabel(scenario, role)}</p>
        <h1>Your panel</h1>
        <p className="page-subtitle">Only what Kaki sends to you appears here.</p>
      </header>
      {connected ? null : <ConnectionBanner />}
      {rejection === null ? null : (
        <RejectionBanner message={`${rejection.commandType}: ${rejection.reason}`} />
      )}
      <Card title="Your tasks">
        {taskList.length === 0 ? (
          <p className="empty-state">No tasks yet.</p>
        ) : (
          <ul className="event-list">
            {taskList.map((task) => (
              <li key={`${task.id}:${task.status}:${task.updatedAt}`}>
                <PhoneTask task={task} scenario={scenario} send={send} />
              </li>
            ))}
          </ul>
        )}
      </Card>
      <EventList events={events} />
    </main>
  );
}

function PhoneTask({
  task,
  scenario,
  send,
}: {
  task: Task;
  scenario: Scenario;
  send: (command: KakiCommand) => void;
}) {
  const [body, setBody] = useState(task.draft?.body ?? '');
  const draft = task.draft;

  useEffect(() => {
    setBody(task.draft?.body ?? '');
  }, [task.draft?.body]);

  return (
    <Card>
      <h2 className="card-title">{task.title}</h2>
      <p className="task-meta">
        <StatusPill status={task.status} /> ·{' '}
        {roleLabel(scenario, task.assignee ?? task.suggestedAssignee)}
      </p>
      {task.error === undefined ? null : <p className="task-error">{task.error}</p>}

      {task.status === 'DISPATCHED' ? (
        <div className="task-actions">
          {task.actionKind === undefined ? null : (
            <Button
              onClick={() => send({ type: 'CLAIM_TASK', taskId: task.id, mode: 'ACTION_AGENT' })}
            >
              Let Kaki do it
            </Button>
          )}
          <Button
            variant="ghost"
            onClick={() => send({ type: 'CLAIM_TASK', taskId: task.id, mode: 'MANUAL' })}
          >
            I'll do it
          </Button>
        </div>
      ) : null}

      {task.status === 'DRAFT_READY' && draft !== undefined ? (
        <>
          <p className="task-meta">To: {draft.target}</p>
          <p className="task-meta">Subject: {draft.subject}</p>
          <label className="draft-field">
            Body
            <textarea
              className="draft-body"
              rows={6}
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
          </label>
          <div className="task-actions">
            <Button
              onClick={() =>
                send({ type: 'APPROVE_ACTION', taskId: task.id, draft: { ...draft, body } })
              }
            >
              Approve
            </Button>
          </div>
        </>
      ) : null}

      {task.status === 'FAILED' ? (
        <div className="task-actions">
          <Button onClick={() => send({ type: 'RETRY_ACTION', taskId: task.id })}>Retry</Button>
        </div>
      ) : null}

      {task.status === 'CLAIMED' && task.mode === 'MANUAL' ? (
        <div className="task-actions">
          <Button onClick={() => send({ type: 'MARK_DONE', taskId: task.id })}>Mark done</Button>
        </div>
      ) : null}

      {task.status === 'COMPLETED' ? (
        <div className="task-actions">
          {task.artifactUrl === undefined ? null : (
            <a className="artifact-link" href={task.artifactUrl} target="_blank" rel="noreferrer">
              Open artifact
            </a>
          )}
          <Button onClick={() => send({ type: 'SYNC_TASK', taskId: task.id })}>Sync to meeting</Button>
        </div>
      ) : null}
    </Card>
  );
}
