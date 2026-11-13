import type { ActionDraft, ActionKind, MeetingMemoryEntry, Scenario, Task, TaskStatus } from '@kaki/shared';
import type { KakiContext, KakiModule } from '../modules';
import type { TaskStore } from '../tasks';

/** An expected action failure whose message can go straight onto the task. */
export class ActionError extends Error {}

/** What one action module supplies: how to draft it and how to run the approved draft. */
export interface ActionModuleOptions {
  name: string;
  kind: ActionKind;
  draft(task: Task, signal: AbortSignal, scenario: KakiContext['scenario'], visitorName?: string, memory?: readonly MeetingMemoryEntry[]): Promise<ActionDraft>;
  run(task: Task, signal: AbortSignal, scenario: KakiContext['scenario'], visitorName?: string): Promise<string>;
}

type TaskPatch = Parameters<TaskStore['transition']>[2];

/** True for a plain JSON object. */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The readable text of anything thrown. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The error in plain words for a person: a connection failure says what to do, with the technical detail after it. */
export function plainReason(error: unknown, service: string): string {
  const raw = messageOf(error);
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
export function createActionModule({ name, kind, draft, run }: ActionModuleOptions): KakiModule {
  return {
    name,
    start({ hub, tasks, scenario, memory, draftOnly }: KakiContext) {
      const shutdown = new AbortController();
      let stopped = false;
      const visitorNameByRole = new Map<string, string>();

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
            const matchedRole = scenario.roles.find((r) => r.label.toLowerCase() === roleLabelText);
            if (matchedRole !== undefined) {
              const seatAttendee = scenario.attendees.find((a) => a.role === matchedRole.id);
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
            result = await draft(task, shutdown.signal, scenario, visitorFor(task), memory);
          } catch (error) {
            fail(task, messageOf(error));
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
          try {
            artifactUrl = await run(task, shutdown.signal, scenario, visitorFor(task));
          } catch (error) {
            fail(task, messageOf(error));
            return;
          }
          if (!isCurrent(task)) return;
          apply(task, 'COMPLETED', { artifactUrl }, 'finish the action');
        });
      }

      const unsubscribe = tasks.onChange((task) => {
        if (task.actionKind !== kind || task.mode !== 'ACTION_AGENT') return;
        if (task.status === 'CLAIMED') {
          draftAction(task);
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
