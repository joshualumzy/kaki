import { errorMessage, type ActionDraft, type ActionKind, type MeetingMemoryEntry, type Scenario, type Task, type TaskStatus } from '@kaki/shared';
import type { KakiContext, KakiModule } from '../core/modules';
import type { TaskStore } from '../meeting/tasks';
import { withActionFooter } from './footer';

/** An expected action failure whose message can go straight onto the task. */
export class ActionError extends Error {}

/** What one action module supplies: how to draft it and how to run the approved draft. */
interface ActionModuleOptions {
  name: string;
  kind: ActionKind;
  /** Why this tool cannot run (with the missing env variable names), when its configuration is absent. */
  unconfiguredReason?: string;
  draft(task: Task, signal: AbortSignal, scenario: Scenario, visitorName?: string, memory?: readonly MeetingMemoryEntry[]): Promise<ActionDraft>;
  run(task: Task, signal: AbortSignal, scenario: Scenario, visitorName?: string): Promise<string>;
}

type TaskPatch = Parameters<TaskStore['transition']>[2];

/** The error in plain words for a person: a connection failure says what to do, with the technical detail after it. */
export function plainReason(error: unknown, service: string): string {
  const raw = errorMessage(error);
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : '';
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EHOSTUNREACH|fetch failed/i.test(`${raw} ${cause}`)) {
    return `${service} is not answering. Check that it is running, then press Retry. (${cause === '' ? raw : `${raw}: ${cause}`})`;
  }
  return raw;
}

/** Facts for the task's recorded agenda item, without guessing from task words. */
export function factsForTask(
  task: Pick<Task, 'agendaItemTitle'>,
  scenario: Scenario,
  roleId: string | undefined,
  includeOtherRoles = false,
): string[] {
  const item = scenario.agenda.find((candidate) => candidate.title === task.agendaItemTitle);
  if (item?.seatFacts === undefined) return [];
  const own = roleId === undefined ? [] : [item.seatFacts[roleId]].filter((fact): fact is string => fact !== undefined);
  if (!includeOtherRoles) return own;
  return [...own, ...Object.entries(item.seatFacts)
    .filter(([id]) => id !== roleId)
    .map(([, fact]) => fact)];
}

/** Create a module that drafts on claim, runs on approval and records the result or failure. */
export function createActionModule({ name, kind, unconfiguredReason, draft, run }: ActionModuleOptions): KakiModule {
  return {
    name,
    start({ hub, tasks, activeScenario, memory, draftOnly }: KakiContext) {
      const shutdown = new AbortController();
      let stopped = false;
      const visitorNameByRole = new Map<string, string>();
      const warnedNoSourceTime = new Set<string>();

      const unsubscribeHub = hub.subscribe((event) => {
        if (event.type === 'MEETING_RESET') {
          visitorNameByRole.clear();
          return;
        }
        if (event.type === 'TRANSCRIPT_CHUNK') {
          const match = /^(.+?)\s*\(([^)]+)\)\s*$/.exec(event.payload.speaker.trim());
          if (match !== null) {
            const speakerName = match[1]!.trim();
            const roleLabelText = match[2]!.trim().toLowerCase();
            const matchedRole = activeScenario().roles.find((r) => r.label.toLowerCase() === roleLabelText);
            if (matchedRole !== undefined) {
              const seatAttendee = activeScenario().attendees.find((a) => a.role === matchedRole.id);
              if (seatAttendee === undefined || seatAttendee.name.toLowerCase() !== speakerName.toLowerCase()) {
                visitorNameByRole.set(matchedRole.id, speakerName);
              }
            }
          }
        }
      });

      // A slow result is only applied when the task has not moved on since it was read.
      function isCurrent(task: Task): boolean {
        if (stopped) return false;
        const current = tasks.get(task.id);
        return current !== undefined && current.status === task.status && current.updatedAt === task.updatedAt;
      }

      function apply(task: Task, to: TaskStatus, patch: TaskPatch, label: string): void {
        if (!isCurrent(task)) return;
        try {
          tasks.transition(task.id, to, patch);
        } catch (error) {
          console.error(`kaki ${name}: could not ${label}`, error);
        }
      }

      function fail(task: Task, message: string): void {
        console.warn(`kaki ${name}: "${task.title}" failed: ${message}`);
        apply(task, 'FAILED', { error: message }, 'record the failure');
      }

      // Every background run ends here, so a rejection can never escape the change handler.
      function background(label: string, work: () => Promise<void>): void {
        work().catch((error: unknown) => {
          if (!stopped) console.error(`kaki ${name}: ${label} failed`, error);
        });
      }

      function visitorFor(task: Task): string | undefined {
        const roleId = task.assignee ?? task.suggestedAssignee;
        if (roleId !== undefined && visitorNameByRole.has(roleId)) {
          return visitorNameByRole.get(roleId);
        }
        return task.assignmentEvidence?.speaker;
      }

      function draftAction(task: Task): void {
        background('drafting the action', async () => {
          let result: ActionDraft;
          try {
            result = await draft(task, shutdown.signal, activeScenario(), visitorFor(task), memory);
          } catch (error) {
            fail(task, errorMessage(error));
            return;
          }
          if (!isCurrent(task)) return;
          apply(task, 'DRAFT_READY', { draft: result }, 'save the draft');
        });
      }

      function runAction(task: Task): void {
        if (draftOnly === true) {
          fail(
            task,
            'Draft-only mode (KAKI_DRAFT_ONLY=1): nothing was sent. Unset it and approve again to run this action.',
          );
          return;
        }
        background('running the action', async () => {
          let artifactUrl: string;
          const draft = task.draft;
          if (draft !== undefined && task.sourceSeconds === undefined && !warnedNoSourceTime.has(task.id)) {
            warnedNoSourceTime.add(task.id);
            console.warn(`[action] card ${task.id} has no source time`);
          }
          // Every artifact ends with where in the meeting it came from, whatever the tool writes.
          const runnable =
            draft === undefined
              ? task
              : { ...task, draft: { ...draft, body: withActionFooter(draft.body, task, activeScenario().meetingTitle) } };
          try {
            artifactUrl = await run(runnable, shutdown.signal, activeScenario(), visitorFor(task));
          } catch (error) {
            fail(task, errorMessage(error));
            return;
          }
          if (!isCurrent(task)) return;
          apply(task, 'COMPLETED', { artifactUrl }, 'finish the action');
        });
      }

      const unsubscribe = tasks.onChange((task) => {
        if (task.actionKind !== kind || task.mode !== 'ACTION_AGENT') return;
        if (task.status === 'CLAIMED') {
          // A task that already carries a draft (the end-of-meeting minutes) is never re-drafted by the LLM.
          if (task.draft !== undefined) return;
          if (unconfiguredReason !== undefined) {
            fail(task, unconfiguredReason);
          } else {
            draftAction(task);
          }
        } else if (task.status === 'RUNNING') {
          runAction(task);
        }
      });

      return () => {
        stopped = true;
        shutdown.abort();
        unsubscribeHub();
        unsubscribe();
      };
    },
  };
}
