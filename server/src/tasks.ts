import { randomUUID } from 'node:crypto';
import {
  canTransition,
  isActionDraft,
  isAssignmentEvidence,
  isRoleIn,
  isSuggestInput,
  type ActionDraft,
  type AssignmentEvidence,
  type KakiCommand,
  type KakiEvent,
  type Role,
  type Scenario,
  type SuggestInput,
  type Task,
  type TaskStatus,
} from '@kaki/shared';
import { CommandError, type ClientAudience, type Hub } from './hub';

type TaskPatch = Partial<Pick<Task, 'assignee' | 'declinedBy' | 'mode' | 'draft' | 'artifactUrl' | 'error'>>;

/** The single owner of task state; every other module changes tasks through it. */
export interface TaskStore {
  /**
   * Suggest a task. `assignmentEvidence` is a separate trusted argument, never part of the public SuggestInput body,
   * so an API caller cannot forge a commitment and have the assignee's responder auto-accept it.
   */
  suggest(input: SuggestInput, assignmentEvidence?: AssignmentEvidence): Task;
  /** Replace an early suggestion with the visitor's final wording before dispatch. */
  reviseSuggested(id: string, input: SuggestInput): Task;
  supersede(id: string): Task;
  get(id: string): Task | undefined;
  list(): Task[];
  transition(id: string, to: TaskStatus, patch?: TaskPatch): Task;
  handleCommand(command: KakiCommand, sender: ClientAudience): void;
  /** Forget every task (a new meeting starts); pages are told by the MEETING_RESET event. */
  reset(): void;
  /**
   * React to task changes here, never via hub TASK_UPDATED: each change goes out once
   * for the screen and again for the assignee. Called once per change, after the hub
   * publishes. Do slow work asynchronously and call transition when done.
   */
  onChange(handler: (task: Task, previous: TaskStatus | undefined) => void): () => void;
}

function taskUpdated(task: Task, audience: KakiEvent['audience']): KakiEvent {
  return { type: 'TASK_UPDATED', audience, payload: { task } };
}

/** Copy evidence so a caller cannot mutate the stored task through the object it passed in, or vice versa. */
function copyAssignmentEvidence(evidence: AssignmentEvidence): AssignmentEvidence {
  return {
    speaker: evidence.speaker,
    quote: evidence.quote,
    scope: {
      title: evidence.scope.title,
      context: evidence.scope.context,
      ...(evidence.scope.actionKind === undefined ? {} : { actionKind: evidence.scope.actionKind }),
    },
  };
}

function assertPatch(patch: TaskPatch, scenario: Scenario): void {
  if (patch.assignee !== undefined && !isRoleIn(scenario, patch.assignee)) {
    throw new CommandError('Unknown assignee role');
  }
  if (patch.mode !== undefined && patch.mode !== 'ACTION_AGENT' && patch.mode !== 'MANUAL') {
    throw new CommandError('Unknown task mode');
  }
  if (patch.draft !== undefined && !isActionDraft(patch.draft)) {
    throw new CommandError('Draft must have a target, subject and body');
  }
  if (patch.artifactUrl !== undefined && typeof patch.artifactUrl !== 'string') {
    throw new CommandError('Artifact URL must be text');
  }
  if (patch.error !== undefined && typeof patch.error !== 'string') {
    throw new CommandError('Error must be text');
  }
}

/** Create the task store that routes task changes through the hub. */
export function createTaskStore({ hub, scenario }: { hub: Hub; scenario: Scenario }): TaskStore {
  const tasks = new Map<string, Task>();
  const changeHandlers = new Set<(task: Task, previous: TaskStatus | undefined) => void>();

  function notifyChange(task: Task, previous: TaskStatus | undefined): void {
    for (const handler of changeHandlers) {
      try {
        handler(task, previous);
      } catch (error) {
        console.error('kaki tasks: a change handler failed', error);
      }
    }
  }

  function publishTask(task: Task, previousAssignee?: Role): void {
    hub.publish(taskUpdated(task, { kind: 'screen' }), { retainKey: `task:${task.id}` });
    // Whoever had the task until now must hear that it is no longer theirs (declined or reassigned).
    for (const role of new Set([previousAssignee, task.assignee])) {
      if (role === undefined) continue;
      hub.publish(taskUpdated(task, { kind: 'role', role }), { retainKey: `task:${task.id}:${role}` });
    }
  }

  function requireTask(id: string): Task {
    const task = tasks.get(id);
    if (task === undefined) throw new CommandError('Task not found');
    return task;
  }

  function transition(id: string, to: TaskStatus, patch: TaskPatch = {}): Task {
    const current = requireTask(id);
    if (!canTransition(current.status, to)) {
      throw new CommandError(`Cannot move a task from ${current.status} to ${to}`);
    }
    assertPatch(patch, scenario);

    const { error, ...rest } = patch;
    const draft: ActionDraft | undefined = patch.draft === undefined ? current.draft : { ...patch.draft };
    const next: Task = {
      ...current,
      ...rest,
      ...(current.assignmentEvidence === undefined
        ? {}
        : { assignmentEvidence: copyAssignmentEvidence(current.assignmentEvidence) }),
      draft,
      status: to,
      updatedAt: new Date().toISOString(),
    };
    if (to === 'FAILED' && error !== undefined) {
      next.error = error;
    } else {
      delete next.error;
    }
    tasks.set(id, next);
    publishTask(next, current.assignee);
    notifyChange(next, current.status);
    return next;
  }

  function suggest(input: SuggestInput, assignmentEvidence?: AssignmentEvidence): Task {
    if (!isSuggestInput(input, scenario)) throw new CommandError('Invalid task suggestion');
    if (assignmentEvidence !== undefined && !isAssignmentEvidence(assignmentEvidence)) {
      throw new CommandError('Invalid assignment evidence');
    }

    const task: Task = {
      id: `task-${randomUUID()}`,
      title: input.title,
      context: input.context,
      suggestedAssignee: input.suggestedAssignee,
      actionKind: input.actionKind,
      ...(input.decisionSource === undefined ? {} : { decisionSource: input.decisionSource }),
      ...(input.agendaItemTitle === undefined ? {} : { agendaItemTitle: input.agendaItemTitle }),
      ...(assignmentEvidence === undefined ? {} : { assignmentEvidence: copyAssignmentEvidence(assignmentEvidence) }),
      status: 'SUGGESTED',
      updatedAt: new Date().toISOString(),
    };
    tasks.set(task.id, task);
    publishTask(task);
    notifyChange(task, undefined);
    return task;
  }

  function reviseSuggested(id: string, input: SuggestInput): Task {
    if (!isSuggestInput(input, scenario)) throw new CommandError('Invalid task suggestion');
    const current = requireTask(id);
    if (current.status !== 'SUGGESTED') throw new CommandError('Only a suggested task can be revised');
    // Evidence for the old scope cannot authorise a changed deliverable.
    const { assignmentEvidence: _oldEvidence, ...base } = current;
    const revised: Task = { ...base, ...input, updatedAt: new Date().toISOString() };
    tasks.set(id, revised);
    publishTask(revised);
    notifyChange(revised, current.status);
    return revised;
  }

  function requireScreen(sender: ClientAudience): void {
    if (sender !== 'screen') throw new CommandError('Only the shared screen can do that');
  }

  function requireAssignee(task: Task, sender: ClientAudience): void {
    if (task.assignee === undefined) throw new CommandError('Task has no assignee');
    if (sender !== task.assignee) throw new CommandError('Only the assigned role can do that');
  }

  function handleCommand(command: KakiCommand, sender: ClientAudience): void {
    switch (command.type) {
      case 'DISPATCH_TASK':
        requireScreen(sender);
        transition(command.taskId, 'DISPATCHED', { assignee: command.assignee });
        return;
      case 'DISMISS_TASK':
        requireScreen(sender);
        transition(command.taskId, 'DISMISSED');
        return;
      case 'DECLINE_TASK': {
        const task = requireTask(command.taskId);
        requireAssignee(task, sender);
        // Back to the shared screen's list with nobody assigned, so a person can offer it to someone else.
        transition(command.taskId, 'SUGGESTED', {
          assignee: undefined,
          declinedBy: [...new Set([...(task.declinedBy ?? []), task.assignee as Role])],
        });
        return;
      }
      case 'CLAIM_TASK': {
        const task = requireTask(command.taskId);
        requireAssignee(task, sender);
        if (command.mode === 'ACTION_AGENT' && task.actionKind === undefined) {
          throw new CommandError('This task has no action to run; do it manually');
        }
        transition(command.taskId, 'CLAIMED', { mode: command.mode });
        return;
      }
      case 'APPROVE_ACTION': {
        const task = requireTask(command.taskId);
        requireAssignee(task, sender);
        transition(command.taskId, 'RUNNING', { draft: command.draft });
        return;
      }
      case 'RETRY_ACTION': {
        const task = requireTask(command.taskId);
        requireAssignee(task, sender);
        const patch = command.draft === undefined ? {} : { draft: command.draft };
        // Without a draft there is nothing to post, so claim again and let the action re-draft.
        const hasDraft = command.draft !== undefined || task.draft !== undefined;
        transition(command.taskId, hasDraft ? 'RUNNING' : 'CLAIMED', patch);
        return;
      }
      case 'MARK_DONE': {
        const task = requireTask(command.taskId);
        requireAssignee(task, sender);
        if (task.mode !== 'MANUAL') throw new CommandError('Only a manual task can be marked done');
        transition(command.taskId, 'COMPLETED');
        return;
      }
      case 'SYNC_TASK': {
        const task = requireTask(command.taskId);
        requireAssignee(task, sender);
        transition(command.taskId, 'SYNCED');
        return;
      }
      case 'END_MEETING':
      case 'NEXT_AGENDA_ITEM':
      case 'SET_HOST_MODE':
        return; // the meeting module owns these
    }
  }

  return {
    suggest,
    reviseSuggested,
    supersede: (id) => transition(id, 'SUPERSEDED'),
    get: (id) => tasks.get(id),
    list: () => [...tasks.values()],
    transition,
    handleCommand,
    reset() {
      tasks.clear();
      hub.clearRetained('task:');
    },
    onChange: (handler) => {
      changeHandlers.add(handler);
      return () => {
        changeHandlers.delete(handler);
      };
    },
  };
}
