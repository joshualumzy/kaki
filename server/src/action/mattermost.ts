import { parseJsonReply, type ChatMessage, type LlmClient } from '../llm';
import type { KakiModule } from '../modules';
import { ActionError, createActionModule, isObject, messageOf } from './runner';

const DEFAULT_TIMEOUT_MS = 10_000;

const CONFIG_MESSAGE =
  'Mattermost is not configured: set MATTERMOST_URL, MATTERMOST_TOKEN, MATTERMOST_TEAM and MATTERMOST_CHANNEL';

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
  function requireSettings(): MattermostSettings {
    if (mattermost === undefined) throw new ActionError(CONFIG_MESSAGE);
    return mattermost;
  }

  async function request(
    settings: MattermostSettings,
    path: string,
    method: 'GET' | 'POST',
    body: string | undefined,
    signal: AbortSignal,
  ): Promise<Response> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const requestSignal = AbortSignal.any([timeout, signal]);
    const headers: Record<string, string> = { authorization: `Bearer ${settings.token}` };
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
          : `could not reach Mattermost: ${messageOf(error)}`,
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
      throw new ActionError(`Mattermost reply is not valid JSON: ${messageOf(error)}`);
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
    async draft(task, signal) {
      const settings = requireSettings();
      if (llm === undefined) {
        throw new ActionError('The LLM is not configured, so the message cannot be drafted');
      }

      const messages: ChatMessage[] = [
        {
          role: 'system',
          content:
            'You turn a team task into a short Mattermost message. Reply with one JSON object and ' +
            'nothing else: {"message": "..."}. Keep it plain and short; Markdown is fine.',
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
        throw new ActionError(`Could not draft the message: ${messageOf(error)}`);
      }

      const message = parseMessage(reply);
      if (message === undefined) {
        throw new ActionError('The LLM did not return usable JSON with a message');
      }
      return { target: `#${settings.channel}`, subject: task.title, body: message };
    },
    async run(task, signal) {
      const settings = requireSettings();
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
