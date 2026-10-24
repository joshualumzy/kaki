import type { Task, TaskStatus } from '@kaki/shared';
import type { ChatMessage, LlmClient } from '../llm';
import type { KakiContext, KakiModule } from '../modules';
import type { TaskStore } from '../tasks';

const DEFAULT_TIMEOUT_MS = 10_000;

/** Where a Gitea issue goes and how to authenticate; `index.ts` builds it from the environment. */
export interface GiteaSettings {
  url: string;
  token: string;
  owner: string;
  repo: string;
}

/** Options for the Gitea action module; tests inject fakes here. */
export interface GiteaModuleOptions {
  llm?: LlmClient;
  gitea?: GiteaSettings;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface IssueDraft {
  title: string;
  body: string;
}

type TaskPatch = Parameters<TaskStore['transition']>[2];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Strictly one JSON object with a non-empty title and body; anything else is unusable.
function parseDraft(reply: string): IssueDraft | undefined {
  let value: unknown;
  try {
    value = JSON.parse(reply);
  } catch {
    return undefined;
  }
  if (!isObject(value)) return undefined;
  const title = typeof value.title === 'string' ? value.title.trim() : '';
  const body = typeof value.body === 'string' ? value.body : '';
  if (title === '' || body.trim() === '') return undefined;
  return { title, body };
}

function issueEndpoint({ url, owner, repo }: GiteaSettings): string {
  return `${url.replace(/\/+$/, '')}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`;
}

/** Create the module that drafts Gitea issues and posts them once the assignee approves. */
export function createGiteaModule({
  llm,
  gitea,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: GiteaModuleOptions = {}): KakiModule {
  return {
    name: 'action-gitea',
    start({ tasks }: KakiContext) {
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
          console.error(`kaki gitea: could not ${label}`, error);
        }
      }

      function fail(task: Task, message: string): void {
        apply(task, 'FAILED', { error: message }, 'record the failure');
      }

      // Every background run ends here, so a rejection can never escape the change handler.
      function run(label: string, work: () => Promise<void>): void {
        work().catch((error: unknown) => {
          if (!stopped) console.error(`kaki gitea: ${label} failed`, error);
        });
      }

      function draftIssue(task: Task): void {
        run('drafting the issue', async () => {
          if (gitea === undefined) {
            fail(task, 'Gitea is not configured: set GITEA_URL, GITEA_TOKEN, GITEA_ORG and GITEA_REPO');
            return;
          }
          if (llm === undefined) {
            fail(task, 'The LLM is not configured, so the issue cannot be drafted');
            return;
          }

          const messages: ChatMessage[] = [
            {
              role: 'system',
              content:
                'You turn a team task into a Gitea issue. Reply with one JSON object and nothing else: ' +
                '{"title": "...", "body": "..."}. The body may use Markdown.',
            },
            {
              role: 'user',
              content: `Task: ${task.title}\n\nContext:\n${task.context}`,
            },
          ];

          let reply: string;
          try {
            reply = await llm.complete(messages, { json: true, signal: shutdown.signal });
          } catch (error) {
            fail(task, `Could not draft the issue: ${messageOf(error)}`);
            return;
          }
          if (!isCurrent(task)) return;

          const draft = parseDraft(reply);
          if (draft === undefined) {
            fail(task, 'The LLM did not return usable JSON with a title and body');
            return;
          }
          apply(
            task,
            'DRAFT_READY',
            { draft: { target: `${gitea.owner}/${gitea.repo}`, subject: draft.title, body: draft.body } },
            'save the draft',
          );
        });
      }

      function postIssue(task: Task): void {
        run('posting the issue', async () => {
          if (gitea === undefined) {
            fail(task, 'Gitea is not configured: set GITEA_URL, GITEA_TOKEN, GITEA_ORG and GITEA_REPO');
            return;
          }
          const draft = task.draft;
          if (draft === undefined) {
            fail(task, 'The task has no draft to post');
            return;
          }

          const timeout = AbortSignal.timeout(timeoutMs);
          const signal = AbortSignal.any([timeout, shutdown.signal]);
          let response: Response;
          try {
            response = await fetchImpl(issueEndpoint(gitea), {
              method: 'POST',
              headers: { 'content-type': 'application/json', authorization: `token ${gitea.token}` },
              body: JSON.stringify({ title: draft.subject, body: draft.body }),
              signal,
            });
          } catch (error) {
            if (stopped) return;
            fail(
              task,
              timeout.aborted
                ? `Gitea timed out after ${timeoutMs} ms`
                : `could not reach Gitea: ${messageOf(error)}`,
            );
            return;
          }
          if (stopped) return;

          if (!response.ok) {
            const detail = (await response.text().catch(() => '')).slice(0, 200).trim();
            fail(
              task,
              response.status === 401 || response.status === 403
                ? `Gitea rejected the token: bad credentials (HTTP ${response.status})`
                : `Gitea returned HTTP ${response.status}${detail === '' ? '' : `: ${detail}`}`,
            );
            return;
          }

          let body: unknown;
          try {
            body = await response.json();
          } catch (error) {
            if (stopped) return;
            fail(task, `Gitea reply is not valid JSON: ${messageOf(error)}`);
            return;
          }
          const artifactUrl = isObject(body) && typeof body.html_url === 'string' ? body.html_url.trim() : '';
          if (artifactUrl === '') {
            fail(task, 'Gitea replied without an issue URL');
            return;
          }
          apply(task, 'COMPLETED', { artifactUrl }, 'finish the issue');
        });
      }

      const unsubscribe = tasks.onChange((task) => {
        if (task.actionKind !== 'gitea_issue' || task.mode !== 'ACTION_AGENT') return;
        if (task.status === 'CLAIMED') {
          draftIssue(task);
        } else if (task.status === 'RUNNING') {
          postIssue(task);
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
