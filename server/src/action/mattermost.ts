import { errorMessage, isObject } from '@kaki/shared';
import { parseJsonReply, type ChatMessage, type LlmClient } from '../services/llm';
import type { KakiModule } from '../core/modules';
import type { WorkspaceTools } from '../workspace/tools';
import { acceptedDecisionBlock, draftSourceText, memorySourceBlock, unsupportedDraftDetails } from './draftGrounding';
import { DEFAULT_PROBE_TIMEOUT_MS, probeFailed, probeFetch, probeOk, responseProblem, type ToolProbeResult } from './probe';
import { ActionError, createActionModule, plainReason, factsForTask } from './runner';

const DEFAULT_TIMEOUT_MS = 10_000;

const CONFIG_MESSAGE = 'Mattermost is not connected for this workspace.';

/** Where Mattermost posts go: server, credentials, team and default channel. */
export interface MattermostSettings {
  url: string;
  token: string;
  team: string;
  channel: string;
}

/** Options for the Mattermost action module; tests inject fakes here. */
export interface MattermostModuleOptions {
  llm?: LlmClient;
  mattermost?: MattermostSettings;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function baseUrl({ url }: MattermostSettings): string {
  return url.replace(/\/+$/, '');
}

/** Checks the saved token belongs to a live Mattermost user. */
export async function probeMattermost(
  settings: MattermostSettings,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<ToolProbeResult> {
  const outcome = await probeFetch(
    fetchImpl,
    `${baseUrl(settings)}/api/v4/users/me`,
    { method: 'GET', headers: { authorization: `Bearer ${settings.token}` } },
    'Mattermost',
    timeoutMs,
  );
  if (!outcome.ok) return outcome.result;
  const response = outcome.response;
  if (!response.ok) return responseProblem(response, 'Mattermost');

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return probeFailed('unexpected response', 'Mattermost answered with something that is not JSON.');
  }
  if (!isObject(body) || typeof body.username !== 'string' || body.username.trim() === '') {
    return probeFailed('unexpected response', 'Mattermost answered without the signed-in user.');
  }
  return probeOk(`Mattermost accepted the token for ${body.username}.`);
}

// Strictly one JSON object with a non-empty message; anything else is unusable.
function parseMessage(reply: string): string | undefined {
  let value: unknown;
  try {
    value = parseJsonReply(reply);
  } catch {
    return undefined;
  }
  if (!isObject(value)) return undefined;
  const message = typeof value.message === 'string' ? value.message.trim() : '';
  return message === '' ? undefined : message;
}

/** Create the module that drafts Mattermost posts and sends them once the assignee approves. */
export function createMattermostModule({
  llm,
  mattermost,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: MattermostModuleOptions = {}): KakiModule {
  function settingsFrom(tools: WorkspaceTools | undefined): MattermostSettings | undefined {
    return mattermost ?? tools?.mattermost;
  }

  function requireSettings(tools: WorkspaceTools | undefined): MattermostSettings {
    const settings = settingsFrom(tools);
    if (settings === undefined) throw new ActionError(CONFIG_MESSAGE);
    return settings;
  }

  async function request(
    settings: MattermostSettings,
    path: string,
    method: 'GET' | 'POST' | 'PUT',
    body: string | undefined,
    signal: AbortSignal,
    overrideToken?: string,
  ): Promise<Response> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const requestSignal = AbortSignal.any([timeout, signal]);
    const headers: Record<string, string> = { authorization: `Bearer ${overrideToken ?? settings.token}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    try {
      return await fetchImpl(`${baseUrl(settings)}${path}`, {
        method,
        headers,
        body,
        signal: requestSignal,
      });
    } catch (error) {
      throw new ActionError(
        timeout.aborted
          ? `Mattermost timed out after ${timeoutMs} ms`
          : plainReason(error, 'Mattermost'),
      );
    }
  }

  async function requireOk(response: Response): Promise<void> {
    if (response.ok) return;
    const detail = (await response.text().catch(() => '')).slice(0, 200).trim();
    throw new ActionError(
      response.status === 401
        ? 'Mattermost rejected the token: bad credentials (HTTP 401)'
        : response.status === 403
          ? 'Mattermost token lacks permission (is the bot a member of the channel?) (HTTP 403)'
          : `Mattermost returned HTTP ${response.status}${detail === '' ? '' : `: ${detail}`}`,
    );
  }

  async function jsonOf(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch (error) {
      throw new ActionError(`Mattermost reply is not valid JSON: ${errorMessage(error)}`);
    }
  }

  function idOf(body: unknown, label: string): string {
    const id = isObject(body) && typeof body.id === 'string' ? body.id.trim() : '';
    if (id === '') throw new ActionError(`Mattermost replied without a ${label} id`);
    return id;
  }

  return createActionModule({
    name: 'action-mattermost',
    kind: 'mattermost_post',
    unconfiguredReason: (tools) => (settingsFrom(tools) === undefined ? CONFIG_MESSAGE : undefined),
    async draft(task, signal, scenario, _visitorName, memory, tools) {
      const settings = requireSettings(tools);
      if (llm === undefined) {
        throw new ActionError('The LLM is not configured, so the message cannot be drafted');
      }

      const roleId = task.assignee ?? task.suggestedAssignee;
      const role = scenario.roles.find((candidate) => candidate.id === roleId);
      const knownFacts = factsForTask(task, scenario, roleId);
      const ownerLine = role !== undefined ? `\nSender role: ${role.label}` : '';
      const factsBlock =
        knownFacts.length > 0
          ? `\n\nKnown facts for ${role !== undefined ? `the ${role.label} role` : 'the sender'}:\n- ${knownFacts.join('\n- ')}`
          : '';

      const messages: ChatMessage[] = [
        {
          role: 'system',
          content:
            'You turn a team task into a short Mattermost message announcing the agreed decision to the team. Reply with one JSON object and ' +
            'nothing else: {"message": "..."}. Keep it plain and short; Markdown is fine.' +
            ' State the specific decision and action steps from the Context clearly. When an Accepted decision is given, it is the authoritative wording: keep its time of day, who owns or enforces it, and how it will be measured; do not leave out a detail it gives. Only include Known facts below if they directly support the agreed solution — NEVER copy-paste background problem complaints or budget warnings as if they were the decision. Do not invent steps, locations, versions, names, dates, start times, or placeholders such as [Insert ...]; if something is not given, leave it out. If the Context gives a time of day without AM or PM, keep it exactly as written; never choose AM or PM yourself. Never write "effective immediately" or another start date unless the Context explicitly states it. Keep the words of the task title in the title.',
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
        throw new ActionError(`Could not draft the message: ${errorMessage(error)}`);
      }

      const message = parseMessage(reply);
      if (message === undefined) {
        throw new ActionError('The LLM did not return usable JSON with a message');
      }
      const unsupported = unsupportedDraftDetails(message, draftSourceText(task, knownFacts, memory));
      if (unsupported.length > 0) {
        throw new ActionError(
          `The draft adds details the task does not support: ${unsupported.join('; ')}. Edit the task or retry.`,
        );
      }
      return { target: `#${settings.channel}`, subject: task.title, body: message };
    },
    async run(task, signal, _scenario, _visitorName, tools) {
      const settings = requireSettings(tools);
      const draft = task.draft;
      if (draft === undefined) throw new ActionError('The task has no draft to post');

      const target = draft.target.trim();
      const channel = (target.startsWith('#') ? target.slice(1) : target).trim();
      if (channel === '') throw new ActionError('The Mattermost channel is empty');

      const lookupPath = `/api/v4/teams/name/${encodeURIComponent(settings.team)}/channels/name/${encodeURIComponent(channel)}`;
      const lookup = await request(settings, lookupPath, 'GET', undefined, signal);
      if (lookup.status === 404) throw new ActionError(`Mattermost channel not found: ${channel}`);
      await requireOk(lookup);
      const channelId = idOf(await jsonOf(lookup), 'channel');

      // Every post is made by the workspace's one bot connection.
      const post = await request(
        settings,
        '/api/v4/posts',
        'POST',
        JSON.stringify({ channel_id: channelId, message: draft.body }),
        signal,
      );
      await requireOk(post);
      const postId = idOf(await jsonOf(post), 'post');

      return `${baseUrl(settings)}/${settings.team}/pl/${postId}`;
    },
  });
}
