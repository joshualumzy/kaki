import { isObject, speakerName } from '@kaki/shared';
import { parseJsonReply, type ChatMessage, type LlmClient } from '../llm';
import type { KakiModule } from '../modules';
import { acceptedDecisionBlock, draftSourceText, memorySourceBlock, unsupportedDraftDetails } from './draftGrounding';
import { DEFAULT_PROBE_TIMEOUT_MS, probeFailed, probeFetch, probeOk, responseProblem, type ToolProbeResult } from './probe';
import { ActionError, createActionModule, messageOf, plainReason, factsForTask } from './runner';

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
  function requireSettings(): MattermostSettings {
    if (mattermost === undefined) throw new ActionError(CONFIG_MESSAGE);
    return mattermost;
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
          : `could not reach Mattermost: ${plainReason(error, 'Mattermost')}`,
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
    unconfiguredReason: mattermost === undefined ? CONFIG_MESSAGE : undefined,
    async draft(task, signal, scenario, _visitorName, memory) {
      const settings = requireSettings();
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
        throw new ActionError(`Could not draft the message: ${messageOf(error)}`);
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
    async run(task, signal, scenario, visitorName) {
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

      let postToken: string | undefined;
      const roleId = task.assignee ?? task.suggestedAssignee;
      const attendee = roleId === undefined ? undefined : scenario.attendees.find((candidate) => candidate.role === roleId);
      const mattermostPassword = process.env.MATTERMOST_PASSWORD;
      if (attendee !== undefined && mattermostPassword !== undefined && mattermostPassword !== '') {
        const speakerRaw = visitorName ?? task.assignmentEvidence?.speaker;
        const cleanSpeaker = speakerRaw === undefined ? undefined : speakerName(speakerRaw);
        const isVisitor =
          cleanSpeaker !== undefined && cleanSpeaker !== '' && cleanSpeaker.toLowerCase() !== attendee.name.toLowerCase();
        const loginIdFor = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, '');
        // The person's own account first: their name comes from the meeting's setup, never from the demo pack.
        const loginIds = [
          ...(isVisitor && cleanSpeaker !== undefined ? [loginIdFor(cleanSpeaker)] : []),
          loginIdFor(attendee.name),
          // The demo pack's own accounts are the demo's, not an owner meeting's. Only a role carrying
          // the pack's card falls back to them, so a pack-free meeting never posts as the demo visitor.
          ...(scenario.roles.some((role) => role.id === roleId && role.card !== undefined)
            ? ['demo@nanyangkopitiam.example', 'demo']
            : []),
        ].filter((candidate, index, all) => candidate !== '' && all.indexOf(candidate) === index);
        try {
          let loginResp: Response | undefined;
          let usedDemoAccount = false;
          for (const candidateLoginId of loginIds) {
            const resp = await request(
              settings,
              '/api/v4/users/login',
              'POST',
              JSON.stringify({ login_id: candidateLoginId, password: mattermostPassword }),
              signal,
            );
            if (resp.ok) {
              loginResp = resp;
              usedDemoAccount = candidateLoginId === 'demo' || candidateLoginId === 'demo@nanyangkopitiam.example';
              break;
            }
          }
          if (loginResp?.ok) {
            const sessionToken = loginResp.headers.get('Token') ?? undefined;
            if (sessionToken !== undefined) {
              postToken = sessionToken;
              if (isVisitor && cleanSpeaker !== undefined) {
                const userObj = (await loginResp.json().catch(() => undefined)) as { id?: string } | undefined;
                if (userObj?.id !== undefined) {
                  await request(
                    settings,
                    `/api/v4/users/${userObj.id}/patch`,
                    'PUT',
                    JSON.stringify({
                      ...(usedDemoAccount ? { username: 'demo', last_name: '' } : {}),
                      first_name: cleanSpeaker,
                      nickname: cleanSpeaker,
                    }),
                    signal,
                    sessionToken,
                  ).catch(() => undefined);
                }
                await request(
                  settings,
                  '/api/v4/config/patch',
                  'PUT',
                  JSON.stringify({ TeamSettings: { TeammateNameDisplay: 'full_name', LockTeammateNameDisplay: true } }),
                  signal,
                  settings.token,
                ).catch(() => undefined);
              }
            }
          }
        } catch {
          // Fall back to default token if per-user login is unavailable.
        }
      }
      // Ensure the posting user (e.g. 'demo' on an older unseeded channel) is a member of the target channel before posting!
      if (postToken !== undefined) {
        const meResp = await request(settings, '/api/v4/users/me', 'GET', undefined, signal, postToken).catch(() => undefined);
        const meObj = (await meResp?.json().catch(() => undefined)) as { id?: string } | undefined;
        if (meObj?.id !== undefined) {
          await request(
            settings,
            `/api/v4/channels/${channelId}/members`,
            'POST',
            JSON.stringify({ user_id: meObj.id }),
            signal,
            settings.token,
          ).catch(() => undefined);
        }
      }

      const post = await request(
        settings,
        '/api/v4/posts',
        'POST',
        JSON.stringify({ channel_id: channelId, message: draft.body }),
        signal,
        postToken,
      );
      await requireOk(post);
      const postId = idOf(await jsonOf(post), 'post');

      return `${baseUrl(settings)}/${settings.team}/pl/${postId}`;
    },
  });
}
