import { errorMessage, type ActionDraft, type ActionKind, type MeetingMemoryEntry, type Scenario, type Task, type TaskStatus } from '@kaki/shared';
import type { KakiContext, KakiModule } from '../core/modules';
import type { TaskStore } from '../meeting/tasks';
import type { WorkspaceTools } from '../workspace/tools';
import { withActionFooter } from './footer';

/** An expected action failure whose message can go straight onto the task. */
export class ActionError extends Error {
  /** A sentence safe to show on the card; the message stays in the log. */
  constructor(message: string, readonly plain?: string) {
    super(message);
  }
}

/** What one action module supplies: how to draft it and how to run the approved draft. */
interface ActionModuleOptions {
  name: string;
  kind: ActionKind;
  /**
   * Why this tool cannot run for this workspace, when its connection is absent. A function reads
   * the workspace's tools; a string is the fixed reason used by tests and the sample.
   */
  unconfiguredReason?: string | ((tools: WorkspaceTools | undefined) => string | undefined);
  draft(
    task: Task,
    signal: AbortSignal,
    scenario: Scenario,
    visitorName?: string,
    memory?: readonly MeetingMemoryEntry[],
    tools?: WorkspaceTools,
  ): Promise<ActionDraft>;
  run(
    task: Task,
    signal: AbortSignal,
    scenario: Scenario,
    visitorName?: string,
    tools?: WorkspaceTools,
  ): Promise<string>;
}

type TaskPatch = Parameters<TaskStore['transition']>[2];

const CONNECTION_FAILURE = /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EHOSTUNREACH|fetch failed/i;

/** The error in plain words for a person; the raw detail goes to the log only. */
export function plainReason(error: unknown, subject: string): string {
  const service = subject.replace(/^The /, 'the ');
  const raw = errorMessage(error);
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : '';
  if (CONNECTION_FAILURE.test(`${raw} ${cause}`)) {
    console.warn(`kaki: could not reach ${service}: ${cause === '' ? raw : `${raw}: ${cause}`}`);
    return `Couldn't reach ${service}. Nothing was sent. Press Retry.`;
  }
  console.warn(`kaki: ${service} failed: ${raw}`);
  return `Something went wrong with ${service}. Nothing was sent. Press Retry.`;
}

/** What a send does, in words for the failure text on a card. */
const SEND_PHRASE: Record<ActionKind, string> = {
  gitea_issue: 'create the Gitea issue',
  mattermost_post: 'post to Mattermost',
  email: 'send the email',
  wiki_page: 'post to the wiki',
  calendar_event: 'add the calendar event',
};

/** A failed send shows a plain sentence on the card: an authored ActionError says its own sentence (`plain` when the log needs more detail than the card), anything else is generic. */
export function sendFailureMessage(error: unknown, kind: ActionKind): string {
  if (error instanceof ActionError) return error.plain ?? error.message;
  return `Couldn't ${SEND_PHRASE[kind]}. Nothing was changed. Press Retry.`;
}

/** A failed draft shows a plain sentence on the card. */
export function draftFailureMessage(error: unknown): string {
  if (error instanceof ActionError) return error.plain ?? error.message;
  return "Couldn't draft this. Press Retry.";
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
    start(ctx: KakiContext) {
      const { hub, tasks, activeScenario, memory, draftOnly } = ctx;
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

      function fail(task: Task, message: string, cause?: unknown): void {
        console.warn(`kaki ${name}: "${task.title}" failed: ${cause === undefined ? message : errorMessage(cause)}`);
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

      /** The person the artifact is posted for: the visitor's own name, else the seat's person. */
      function approverName(task: Task): string {
        const visitor = visitorFor(task);
        if (visitor !== undefined && visitor.trim() !== '') return visitor.trim();
        const roleId = task.assignee ?? task.suggestedAssignee;
        const scenario = activeScenario();
        const attendee = roleId === undefined ? undefined : scenario.attendees.find((entry) => entry.role === roleId);
        if (attendee !== undefined && attendee.name.trim() !== '') return attendee.name.trim();
        const role = roleId === undefined ? undefined : scenario.roles.find((entry) => entry.id === roleId);
        return role?.label ?? 'the team';
      }

      async function workspaceTools(): Promise<WorkspaceTools | undefined> {
        return ctx.tools === undefined ? undefined : ctx.tools();
      }

      function configReason(tools: WorkspaceTools | undefined): string | undefined {
        return typeof unconfiguredReason === 'function' ? unconfiguredReason(tools) : unconfiguredReason;
      }

      function draftAction(task: Task): void {
        background('drafting the action', async () => {
          let tools: WorkspaceTools | undefined;
          try {
            tools = await workspaceTools();
          } catch (error) {
            fail(task, "Couldn't load this workspace's tools. Press Retry.", error);
            return;
          }
          const reason = configReason(tools);
          if (reason !== undefined) {
            fail(task, reason);
            return;
          }
          let result: ActionDraft;
          try {
            result = await draft(task, shutdown.signal, activeScenario(), visitorFor(task), memory, tools);
          } catch (error) {
            fail(task, draftFailureMessage(error), error);
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
          let tools: WorkspaceTools | undefined;
          try {
            tools = await workspaceTools();
          } catch (error) {
            fail(task, "Couldn't load this workspace's tools. Press Retry.", error);
            return;
          }
          const reason = configReason(tools);
          if (reason !== undefined) {
            fail(task, reason);
            return;
          }
          let artifactUrl: string;
          const draft = task.draft;
          if (draft !== undefined && task.sourceSeconds === undefined && !warnedNoSourceTime.has(task.id)) {
            warnedNoSourceTime.add(task.id);
            console.warn(`[action] card ${task.id} has no source time`);
          }
          // Every artifact ends with who it is for and which meeting approved it.
          const runnable =
            draft === undefined
              ? task
              : {
                  ...task,
                  draft: {
                    ...draft,
                    body: withActionFooter(
                      draft.body,
                      task,
                      activeScenario().meetingTitle,
                      approverName(task),
                    ),
                  },
                };
          try {
            artifactUrl = await run(runnable, shutdown.signal, activeScenario(), visitorFor(task), tools);
          } catch (error) {
            fail(task, sendFailureMessage(error, kind), error);
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
