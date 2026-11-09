import type { ActionDraft, ActionKind, Task, TaskStatus } from '@kaki/shared';
import type { KakiContext, KakiModule } from '../modules';
import type { TaskStore } from '../tasks';

/** An expected action failure whose message can go straight onto the task. */
export class ActionError extends Error {}

/** What one action module supplies: how to draft it and how to run the approved draft. */
export interface ActionModuleOptions {
  name: string;
  kind: ActionKind;
  draft(task: Task, signal: AbortSignal, scenario: KakiContext['scenario']): Promise<ActionDraft>;
  run(task: Task, signal: AbortSignal, scenario: KakiContext['scenario']): Promise<string>;
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

const GENERIC_TASK_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'are', 'was', 'were',
  'have', 'has', 'had', 'not', 'but', 'what', 'when', 'who', 'how', 'why', 'where',
  'your', 'you', 'our', 'their', 'they', 'will', 'can', 'just', 'more', 'first',
  'post', 'send', 'draft', 'write', 'file', 'create', 'update', 'team', 'channel',
  'today', 'everyone', 'decision', 'about', 'regarding', 'issue', 'ticket', 'page',
  'email', 'confirm', 'follow', 'asked', 'requested',
]);

/** Filter a role's known facts to only those overlapping the task's topic words (plus any facts with email addresses when drafting an email). */
export function relevantFactsForTask(
  task: Pick<Task, 'title' | 'context'>,
  facts: readonly string[],
  includeEmailFacts = false,
): string[] {
  if (facts.length <= 1) return [...facts];
  const text = `${task.title} ${task.context}`.toLowerCase();
  const keywords = (text.match(/[a-z0-9]+/g) ?? []).filter(
    (word) => (word.length >= 4 || /^\d+$/.test(word)) && !GENERIC_TASK_WORDS.has(word),
  );
  if (keywords.length === 0) return [...facts];
  const scored = facts.map((fact) => {
    const lower = fact.toLowerCase();
    const hits = keywords.filter((word) => new RegExp(`\\b${word}\\b`, 'i').test(lower)).length;
    const hasEmail = includeEmailFacts && /@/.test(fact);
    return { fact, hits: hits + (hasEmail ? 1 : 0) };
  });
  const matching = scored.filter((entry) => entry.hits > 0);
  if (matching.length === 0) return [];
  const maxHits = Math.max(...matching.map((entry) => entry.hits));
  const threshold = maxHits >= 2 ? 2 : 1;
  return matching.filter((entry) => entry.hits >= threshold).map((entry) => entry.fact);
}

/** Create a module that drafts on claim, runs on approval and records the result or failure. */
export function createActionModule({ name, kind, draft, run }: ActionModuleOptions): KakiModule {
  return {
    name,
    start({ tasks, scenario, draftOnly }: KakiContext) {
      const shutdown = new AbortController();
      let stopped = false;

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

      function draftAction(task: Task): void {
        background('drafting the action', async () => {
          let result: ActionDraft;
          try {
            result = await draft(task, shutdown.signal, scenario);
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
            artifactUrl = await run(task, shutdown.signal, scenario);
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
        unsubscribe();
      };
    },
  };
}
