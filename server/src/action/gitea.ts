import type { ChatMessage, LlmClient } from '../llm';
import type { KakiModule } from '../modules';
import { ActionError, createActionModule } from './runner';

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

const CONFIG_MESSAGE = 'Gitea is not configured: set GITEA_URL, GITEA_TOKEN, GITEA_ORG and GITEA_REPO';

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
  return createActionModule({
    name: 'action-gitea',
    kind: 'gitea_issue',
    async draft(task, signal) {
      if (gitea === undefined) throw new ActionError(CONFIG_MESSAGE);
      if (llm === undefined) {
        throw new ActionError('The LLM is not configured, so the issue cannot be drafted');
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
        reply = await llm.complete(messages, { json: true, signal });
      } catch (error) {
        throw new ActionError(`Could not draft the issue: ${messageOf(error)}`);
      }

      const draft = parseDraft(reply);
      if (draft === undefined) {
        throw new ActionError('The LLM did not return usable JSON with a title and body');
      }
      return { target: `${gitea.owner}/${gitea.repo}`, subject: draft.title, body: draft.body };
    },
    async run(task, signal) {
      if (gitea === undefined) throw new ActionError(CONFIG_MESSAGE);
      const draft = task.draft;
      if (draft === undefined) throw new ActionError('The task has no draft to post');

      const timeout = AbortSignal.timeout(timeoutMs);
      const requestSignal = AbortSignal.any([timeout, signal]);
      let response: Response;
      try {
        response = await fetchImpl(issueEndpoint(gitea), {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `token ${gitea.token}` },
          body: JSON.stringify({ title: draft.subject, body: draft.body }),
          signal: requestSignal,
        });
      } catch (error) {
        throw new ActionError(
          timeout.aborted
            ? `Gitea timed out after ${timeoutMs} ms`
            : `could not reach Gitea: ${messageOf(error)}`,
        );
      }

      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 200).trim();
        throw new ActionError(
          response.status === 401 || response.status === 403
            ? `Gitea rejected the token: bad credentials (HTTP ${response.status})`
            : `Gitea returned HTTP ${response.status}${detail === '' ? '' : `: ${detail}`}`,
        );
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        throw new ActionError(`Gitea reply is not valid JSON: ${messageOf(error)}`);
      }
      const artifactUrl = isObject(body) && typeof body.html_url === 'string' ? body.html_url.trim() : '';
      if (artifactUrl === '') throw new ActionError('Gitea replied without an issue URL');
      return artifactUrl;
    },
  });
}
