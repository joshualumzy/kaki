import { errorMessage, isObject } from '@kaki/shared';
import type { ChatMessage, LlmClient } from '../services/llm';
import type { KakiModule } from '../core/modules';
import type { WorkspaceTools } from '../workspace/tools';
import { draftString, parseDraftObject } from './draft';
import { acceptedDecisionBlock, draftSourceText, memorySourceBlock, unsupportedDraftDetails } from './draftGrounding';
import { DEFAULT_PROBE_TIMEOUT_MS, probeFailed, probeFetch, probeOk, responseProblem, type ToolProbeResult } from './probe';
import { ActionError, createActionModule, plainReason, factsForTask } from './runner';

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

const CONFIG_MESSAGE = 'Gitea is not connected for this workspace.';

// Strictly one JSON object with a non-empty title and body; anything else is unusable.
function parseDraft(reply: string): IssueDraft | undefined {
  const value = parseDraftObject(reply);
  if (value === undefined) return undefined;
  const title = draftString(value, 'title').trim();
  const body = draftString(value, 'body');
  if (title === '' || body.trim() === '') return undefined;
  return { title, body };
}

function issueEndpoint({ url, owner, repo }: GiteaSettings): string {
  return `${url.replace(/\/+$/, '')}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`;
}

/** Checks the saved token signs in to Gitea and returns the account name. */
export async function probeGitea(
  settings: GiteaSettings,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<ToolProbeResult> {
  const outcome = await probeFetch(
    fetchImpl,
    `${settings.url.replace(/\/+$/, '')}/api/v1/user`,
    { method: 'GET', headers: { authorization: `token ${settings.token}` } },
    'Gitea',
    timeoutMs,
  );
  if (!outcome.ok) return outcome.result;
  const response = outcome.response;
  if (!response.ok) return responseProblem(response, 'Gitea');

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return probeFailed('unexpected response', 'Gitea answered with something that is not JSON.');
  }
  if (!isObject(body) || typeof body.login !== 'string' || body.login.trim() === '') {
    return probeFailed('unexpected response', 'Gitea answered without the signed-in user.');
  }
  return probeOk(`Gitea accepted the token for ${body.login}.`);
}

/** Create the module that drafts Gitea issues and posts them once the assignee approves. */
export function createGiteaModule({
  llm,
  gitea,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: GiteaModuleOptions = {}): KakiModule {
  function settingsFrom(tools: WorkspaceTools | undefined): GiteaSettings | undefined {
    return gitea ?? tools?.gitea;
  }

  function requireSettings(tools: WorkspaceTools | undefined): GiteaSettings {
    const settings = settingsFrom(tools);
    if (settings === undefined) throw new ActionError(CONFIG_MESSAGE);
    return settings;
  }

  return createActionModule({
    name: 'action-gitea',
    kind: 'gitea_issue',
    unconfiguredReason: (tools) => (settingsFrom(tools) === undefined ? CONFIG_MESSAGE : undefined),
    async draft(task, signal, scenario, _visitorName, memory, tools) {
      const settings = requireSettings(tools);
      if (llm === undefined) {
        throw new ActionError('The LLM is not configured, so the issue cannot be drafted');
      }

      const roleId = task.assignee ?? task.suggestedAssignee;
      const role = scenario.roles.find((candidate) => candidate.id === roleId);
      const knownFacts = factsForTask(task, scenario, roleId);
      const ownerLine = role !== undefined ? `\nOwner role: ${role.label}` : '';
      const factsBlock =
        knownFacts.length > 0
          ? `\n\nKnown facts for ${role !== undefined ? `the ${role.label} role` : 'the owner'}:\n- ${knownFacts.join('\n- ')}`
          : '';

      const messages: ChatMessage[] = [
        {
          role: 'system',
          content:
            'You turn a team task into a Gitea issue. Reply with one JSON object and nothing else: ' +
            '{"title": "...", "body": "..."}. The body may use Markdown, in a few plain sentences, not a template.' +
            ' Use only what is in the task, its context, and any known facts below that are directly about the same topic as the task (ignore known facts about unrelated issues or other agenda items). When an Accepted decision is given, keep its time of day, who owns or enforces it, and how it will be measured; do not leave out a detail it gives. Do not invent steps, versions, names, dates, numbers or placeholders such as [Insert ...]; if something is not given, leave it out. If the Context gives a time of day without AM or PM, keep it exactly as written; never choose AM or PM yourself. Never write "effective immediately" or another start date unless the Context explicitly states it. Keep the words of the task title in the title.',
        },
        {
          role: 'user',
          content: `Task: ${task.title}${ownerLine}\n\nContext:\n${task.context}${factsBlock}${acceptedDecisionBlock(task.decisionSource)}${memorySourceBlock(memory)}`,
        },
      ];

      let reply: string;
      try {
        reply = await llm.complete(messages, { json: true, signal });
      } catch (error) {
        throw new ActionError(`Could not draft the issue: ${errorMessage(error)}`);
      }

      const draft = parseDraft(reply);
      if (draft === undefined) {
        throw new ActionError('The LLM did not return usable JSON with a title and body');
      }
      const unsupported = unsupportedDraftDetails(
        `${draft.title}\n${draft.body}`,
        draftSourceText(task, knownFacts, memory),
      );
      if (unsupported.length > 0) {
        throw new ActionError(
          `The draft adds details the task does not support: ${unsupported.join('; ')}. Edit the task or retry.`,
        );
      }
      return { target: `${settings.owner}/${settings.repo}`, subject: draft.title, body: draft.body };
    },
    async run(task, signal, _scenario, _visitorName, tools) {
      const settings = requireSettings(tools);
      const draft = task.draft;
      if (draft === undefined) throw new ActionError('The task has no draft to post');

      // Every issue is created by the workspace's one bot connection.
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        authorization: `token ${settings.token}`,
      };

      const timeout = AbortSignal.timeout(timeoutMs);
      const requestSignal = AbortSignal.any([timeout, signal]);
      let response: Response;
      try {
        response = await fetchImpl(issueEndpoint(settings), {
          method: 'POST',
          headers,
          body: JSON.stringify({ title: draft.subject, body: draft.body }),
          signal: requestSignal,
        });
      } catch (error) {
        throw new ActionError(
          timeout.aborted
            ? `Gitea timed out after ${timeoutMs} ms; check Gitea before retrying, the issue may already exist`
            : plainReason(error, 'Gitea'),
        );
      }

      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 200).trim();
        throw new ActionError(
          response.status === 401
            ? 'Gitea rejected the token: bad credentials (HTTP 401)'
            : response.status === 403
              ? `Gitea token lacks permission to create issues in ${settings.owner}/${settings.repo} (HTTP 403)`
              : `Gitea returned HTTP ${response.status}${detail === '' ? '' : `: ${detail}`}`,
        );
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        throw new ActionError(`Gitea reply is not valid JSON: ${errorMessage(error)}`);
      }
      const artifactUrl = isObject(body) && typeof body.html_url === 'string' ? body.html_url.trim() : '';
      if (artifactUrl === '') throw new ActionError('Gitea replied without an issue URL');
      return artifactUrl;
    },
  });
}
