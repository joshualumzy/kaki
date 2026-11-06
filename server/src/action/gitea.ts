import { parseJsonReply, type ChatMessage, type LlmClient } from '../llm';
import type { KakiModule } from '../modules';
import { ActionError, createActionModule, isObject, messageOf, plainReason } from './runner';

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

// Strictly one JSON object with a non-empty title and body; anything else is unusable.
function parseDraft(reply: string): IssueDraft | undefined {
  let value: unknown;
  try {
    value = parseJsonReply(reply);
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

function giteaUsernameFor(scenario: Parameters<Parameters<typeof createActionModule>[0]['run']>[2], roleId: string | undefined): string | undefined {
  if (roleId === undefined) return undefined;
  const attendee = scenario.attendees.find((candidate) => candidate.role === roleId);
  if (attendee === undefined || !scenario.roles.some((r) => r.id === roleId && r.card !== undefined)) return undefined;
  return attendee.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
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
    async draft(task, signal, scenario) {
      if (gitea === undefined) throw new ActionError(CONFIG_MESSAGE);
      if (llm === undefined) {
        throw new ActionError('The LLM is not configured, so the issue cannot be drafted');
      }

      const roleId = task.assignee ?? task.suggestedAssignee;
      const role = scenario.roles.find((candidate) => candidate.id === roleId);
      const attendee = scenario.attendees.find((candidate) => candidate.role === roleId);
      const knownFacts = role?.card?.facts ?? [];
      const ownerLine =
        attendee !== undefined && role !== undefined ? `\nOwner: ${attendee.name} (${role.label})` : '';
      const factsBlock =
        knownFacts.length > 0 ? `\n\nKnown facts from ${attendee?.name ?? 'the owner'}:\n- ${knownFacts.join('\n- ')}` : '';

      const messages: ChatMessage[] = [
        {
          role: 'system',
          content:
            'You turn a team task into a Gitea issue. Reply with one JSON object and nothing else: ' +
            '{"title": "...", "body": "..."}. The body may use Markdown, in a few plain sentences, not a template.' +
            ' Use only what is in the task, its context, and any known facts below that are directly about the same topic as the task (ignore known facts about unrelated issues or other agenda items). Do not invent steps, versions, names, dates, numbers or placeholders such as [Insert ...]; if something is not given, leave it out. Keep the words of the task title in the title.',
        },
        {
          role: 'user',
          content: `Task: ${task.title}${ownerLine}\n\nContext:\n${task.context}${factsBlock}`,
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
    async run(task, signal, scenario) {
      if (gitea === undefined) throw new ActionError(CONFIG_MESSAGE);
      const draft = task.draft;
      if (draft === undefined) throw new ActionError('The task has no draft to post');

      const sudoUser = giteaUsernameFor(scenario, task.assignee ?? task.suggestedAssignee);
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        authorization: `token ${gitea.token}`,
        ...(sudoUser === undefined ? {} : { Sudo: sudoUser }),
      };

      const timeout = AbortSignal.timeout(timeoutMs);
      const requestSignal = AbortSignal.any([timeout, signal]);
      let response: Response;
      try {
        response = await fetchImpl(issueEndpoint(gitea), {
          method: 'POST',
          headers,
          body: JSON.stringify({ title: draft.subject, body: draft.body }),
          signal: requestSignal,
        });
      } catch (error) {
        throw new ActionError(
          timeout.aborted
            ? `Gitea timed out after ${timeoutMs} ms; check Gitea before retrying, the issue may already exist`
            : `could not reach Gitea: ${plainReason(error, 'Gitea')}`,
        );
      }

      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 200).trim();
        throw new ActionError(
          response.status === 401
            ? 'Gitea rejected the token: bad credentials (HTTP 401)'
            : response.status === 403
              ? `Gitea token lacks permission to create issues in ${gitea.owner}/${gitea.repo} (HTTP 403)`
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
