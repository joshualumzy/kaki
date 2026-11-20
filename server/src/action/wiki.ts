import { humanSeatRoles, roleLabel, type Question, type Role, type Scenario, type Task } from '@kaki/shared';
import { parseJsonReply, type ChatMessage, type LlmClient } from '../llm';
import type { KakiModule } from '../modules';
import { acceptedDecisionBlock, memorySourceBlock } from './draftGrounding';
import { DEFAULT_PROBE_TIMEOUT_MS, probeFailed, probeFetch, probeOk, responseProblem, type ToolProbeResult } from './probe';
import { ActionError, createActionModule, isObject, messageOf, plainReason, factsForTask } from './runner';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MINUTES_DELAY_MS = 1_500;

const CONFIG_MESSAGE = 'The wiki is not configured: set WIKI_URL, WIKI_ADMIN_EMAIL and WIKI_ADMIN_PASSWORD';

/** Where wiki pages go and who writes them; `index.ts` builds it from the environment. */
export interface WikiSettings {
  url: string;
  email: string;
  password: string;
}

/** Options for the wiki action module; tests inject fakes here. */
export interface WikiModuleOptions {
  llm?: LlmClient;
  wiki?: WikiSettings;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** How long after `CLOSING` to wait for the final notetaker pass before publishing end-of-meeting minutes. */
  minutesDelayMs?: number;
  /** Today's date as YYYY-MM-DD; tests fix it. */
  today?: () => string;
}

/** Format the complete end-of-meeting minutes as Markdown for the team wiki. */
export function buildMeetingMinutes(
  scenario: Scenario,
  date: string,
  transcript: ReadonlyArray<{ speaker: string; text: string }>,
  openQuestions: readonly Question[],
  allTasks: readonly Task[],
): string {
  const sections: string[] = [
    `# ${scenario.meetingTitle} — Meeting Minutes`,
    `**Date:** ${date}`,
    '',
    '## Agenda Covered',
    ...scenario.agenda.map((item, idx) => {
      const decisionSuffix = item.decision !== undefined ? ` — ${item.decision}` : '';
      return `${idx + 1}. **${item.title}** (${item.minutes} min · ${roleLabel(scenario, item.ownerRole)})${decisionSuffix}`;
    }),
  ];

  const activeTasks = allTasks.filter(
    (task) => task.status !== 'DISMISSED' && task.purpose !== 'meeting_minutes',
  );
  sections.push('', '## Action Items & Follow-Ups');
  if (activeTasks.length === 0) {
    sections.push('- None recorded.');
  } else {
    for (const task of activeTasks) {
      const owner = roleLabel(scenario, task.assignee ?? task.suggestedAssignee);
      const linkSuffix = task.artifactUrl !== undefined ? ` ([Open artifact](${task.artifactUrl}))` : '';
      sections.push(`- **${task.title}** — *${owner}* (${task.status.toLowerCase()})${linkSuffix}`);
      if (task.context.trim() !== '') {
        sections.push(`  - ${task.context.trim()}`);
      }
    }
  }

  sections.push('', '## Open Questions');
  if (openQuestions.length === 0) {
    sections.push('- None remaining.');
  } else {
    for (const question of openQuestions) {
      const ownerSuffix = question.forRole !== undefined ? ` *(${roleLabel(scenario, question.forRole)})*` : '';
      sections.push(`- ${question.text}${ownerSuffix}`);
    }
  }

  if (transcript.length > 0) {
    sections.push('', '## Discussion Transcript');
    for (const line of transcript) {
      sections.push(`- **${line.speaker}:** ${line.text}`);
    }
  }

  return sections.join('\n');
}

/**
 * Who reviews and approves the end-of-meeting minutes: a person in the room, never an AI seat.
 * The owner's (facilitator's) chair wins when a person holds it, then the first person seat a
 * holder is actually in. `presentSeats` is the app's own seat-holder record, so a seat nobody
 * holds is never assigned: its assignee could not approve the card.
 */
function minutesAssignee(
  scenario: Scenario,
  presentSeats: ReadonlyArray<{ seat: string }>,
): Role | undefined {
  const present = new Set(presentSeats.map((entry) => entry.seat.trim().toLowerCase()));
  const humanPresent = humanSeatRoles(scenario).filter((role) => present.has(role.id.toLowerCase()));
  const ownerSeat = humanPresent.find((role) => role.facilitator === true);
  return (ownerSeat ?? humanPresent[0])?.id;
}

interface PageDraft {
  title: string;
  body: string;
}

// Strictly one JSON object with a non-empty title and body; anything else is unusable.
function parseDraft(reply: string): PageDraft | undefined {
  let value: unknown;
  try {
    value = parseJsonReply(reply);
  } catch {
    return undefined;
  }
  if (!isObject(value)) return undefined;
  const title = typeof value.title === 'string' ? value.title.trim() : '';
  const body = typeof value.body === 'string' ? value.body.trim() : '';
  if (title === '' || body === '') return undefined;
  return { title, body };
}

/** A wiki path under meetings/ made from the date and title, e.g. meetings/2026-11-03-launch-notes. */
export function pagePath(date: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return `meetings/${date}-${slug === '' ? 'notes' : slug}`;
}

/** A wiki request that outlasted its timeout; the write may still have happened. */
class WikiTimeout extends ActionError {
  constructor(timeoutMs: number) {
    super(`The wiki timed out after ${timeoutMs} ms`);
  }
}

function wikiError(message: string): ActionError {
  return new ActionError(message);
}

const PROBE_LOGIN_QUERY = `mutation Login($username: String!, $password: String!, $strategy: String!) {
  authentication { login(username: $username, password: $password, strategy: $strategy) {
    jwt responseResult { succeeded message } } }
}`;

const PROBE_READ_QUERY = `query ProbeRead { pages { list { id } } }`;

async function wikiGraphqlBody(
  fetchImpl: typeof fetch,
  settings: WikiSettings,
  query: string,
  variables: Record<string, unknown>,
  timeoutMs: number,
  jwt?: string,
): Promise<{ body?: unknown; result?: ToolProbeResult }> {
  const outcome = await probeFetch(
    fetchImpl,
    `${settings.url.replace(/\/+$/, '')}/graphql`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(jwt === undefined ? {} : { authorization: `Bearer ${jwt}` }),
      },
      body: JSON.stringify({ query, variables }),
    },
    'The wiki',
    timeoutMs,
  );
  if (!outcome.ok) return { result: outcome.result };
  if (!outcome.response.ok) return { result: responseProblem(outcome.response, 'The wiki') };
  try {
    return { body: (await outcome.response.json()) as unknown };
  } catch {
    return { result: probeFailed('unexpected response', 'The wiki answered with something that is not JSON.') };
  }
}

export async function probeWiki(
  settings: WikiSettings,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<ToolProbeResult> {
  const login = await wikiGraphqlBody(
    fetchImpl,
    settings,
    PROBE_LOGIN_QUERY,
    { username: settings.email, password: settings.password, strategy: 'local' },
    timeoutMs,
  );
  if (login.result !== undefined) return login.result;
  if (!isObject(login.body)) return probeFailed('unexpected response', 'The wiki answered with an unexpected login reply.');

  const loginResult = isObject(login.body.data) && isObject(login.body.data.authentication) && isObject(login.body.data.authentication.login)
    ? login.body.data.authentication.login
    : undefined;
  const responseResult = loginResult !== undefined && isObject(loginResult.responseResult) ? loginResult.responseResult : undefined;
  const jwt = loginResult !== undefined && typeof loginResult.jwt === 'string' ? loginResult.jwt : '';
  if (responseResult?.succeeded !== true || jwt === '') {
    const detail = responseResult !== undefined && typeof responseResult.message === 'string' && responseResult.message.trim() !== ''
      ? ` (${responseResult.message.trim()})`
      : '';
    return probeFailed('auth failed', `The wiki rejected the saved login${detail}.`);
  }

  const read = await wikiGraphqlBody(fetchImpl, settings, PROBE_READ_QUERY, {}, timeoutMs, jwt);
  if (read.result !== undefined) return read.result;
  if (!isObject(read.body)) return probeFailed('unexpected response', 'The wiki answered with an unexpected reply.');
  if (Array.isArray(read.body.errors) && read.body.errors.length > 0) {
    return probeFailed('unexpected response', 'The wiki could not list a page with the saved login.');
  }
  const pages = isObject(read.body.data) && isObject(read.body.data.pages) ? read.body.data.pages : undefined;
  if (pages === undefined || !Array.isArray(pages.list)) {
    return probeFailed('unexpected response', 'The wiki answered without a page list.');
  }
  return probeOk('The wiki accepted the login and can be read.');
}

/** Create the module that drafts a wiki page and publishes it once the assignee approves, including end-of-meeting minutes. */
export function createWikiModule({
  llm,
  wiki,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  minutesDelayMs = DEFAULT_MINUTES_DELAY_MS,
  today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' }),
}: WikiModuleOptions = {}): KakiModule {
  async function graphql<T>(
    settings: WikiSettings,
    query: string,
    variables: Record<string, unknown>,
    signal: AbortSignal,
    jwt?: string,
  ): Promise<T> {
    const timeout = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(`${settings.url.replace(/\/+$/, '')}/graphql`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(jwt === undefined ? {} : { authorization: `Bearer ${jwt}` }),
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.any([timeout, signal]),
      });
    } catch (error) {
      if (timeout.aborted) throw new WikiTimeout(timeoutMs);
      throw wikiError(`could not reach the wiki: ${plainReason(error, 'The wiki')}`);
    }
    if (!response.ok) throw wikiError(`The wiki returned HTTP ${response.status}`);
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw wikiError(`The wiki reply is not valid JSON: ${messageOf(error)}`);
    }
    if (!isObject(body)) throw wikiError('The wiki reply is not valid JSON');
    if (Array.isArray(body.errors) && body.errors.length > 0) {
      const first: unknown = body.errors[0];
      throw wikiError(`The wiki said: ${isObject(first) && typeof first.message === 'string' ? first.message : 'an error'}`);
    }
    return body.data as T;
  }

  async function publishPage(
    settings: WikiSettings,
    path: string,
    title: string,
    content: string,
    description: string,
    signal: AbortSignal,
  ): Promise<string> {
    const login = await graphql<{
      authentication: { login: { jwt?: string; responseResult: { succeeded: boolean; message?: string } } };
    }>(
      settings,
      `mutation Login($username: String!, $password: String!, $strategy: String!) {
        authentication { login(username: $username, password: $password, strategy: $strategy) {
          jwt responseResult { succeeded message } } }
      }`,
      { username: settings.email, password: settings.password, strategy: 'local' },
      signal,
    );
    const auth = login.authentication.login;
    if (!auth.responseResult.succeeded || auth.jwt === undefined) {
      throw wikiError(`The wiki rejected the login: ${auth.responseResult.message ?? 'no token returned'}`);
    }

    const createdOrTimedOut = await graphql<{
      pages: { create: { responseResult: { succeeded: boolean; message?: string } } };
    }>(
      settings,
      `mutation Create($content: String!, $description: String!, $path: String!, $title: String!) {
        pages { create(content: $content, description: $description, editor: "markdown",
          isPublished: true, isPrivate: false, locale: "en", path: $path, tags: [], title: $title) {
          responseResult { succeeded message } } }
      }`,
      { content, description: description.slice(0, 200), path, title },
      signal,
      auth.jwt,
    ).catch(async (error: unknown) => {
      // The wiki renders and rebuilds its page tree before answering a create, which can outlast the timeout
      // although the page was written. Look it up instead of reporting a failure that did not happen.
      if (!(error instanceof WikiTimeout)) throw error;
      let recent: { pages: { list: Array<{ path: string }> } };
      try {
        recent = await graphql<{ pages: { list: Array<{ path: string }> } }>(
          settings,
          `query Recent { pages { list(limit: 50, orderBy: UPDATED, orderByDirection: DESC, locale: "en") { path } } }`,
          {},
          signal,
          auth.jwt,
        );
      } catch (lookupError) {
        throw wikiError(
          `${error.message} and could not be checked afterwards (${messageOf(lookupError)}); check the wiki for ${path} before retrying`,
        );
      }
      if (recent.pages.list.some((page) => page.path === path)) return undefined;
      throw wikiError(`${error.message}; the page ${path} is not there, so it is safe to retry`);
    });
    if (createdOrTimedOut === undefined) return `${settings.url.replace(/\/+$/, '')}/en/${path}`;
    const result = createdOrTimedOut.pages.create.responseResult;
    // A retry after a lost reply finds the page already there: link it rather than fail or duplicate.
    if (!result.succeeded && !/already exist/i.test(result.message ?? '')) {
      throw wikiError(`The wiki could not create the page ${path}: ${result.message ?? 'unknown error'}`);
    }
    return `${settings.url.replace(/\/+$/, '')}/en/${path}`;
  }

  const baseModule = createActionModule({
    name: 'action-wiki',
    kind: 'wiki_page',
    unconfiguredReason: wiki === undefined ? CONFIG_MESSAGE : undefined,
    async draft(task, signal, scenario, _visitorName, memory) {
      if (wiki === undefined) throw new ActionError(CONFIG_MESSAGE);
      if (llm === undefined) throw new ActionError('The LLM is not configured, so the page cannot be drafted');

      const roleId = task.assignee ?? task.suggestedAssignee;
      const role = scenario.roles.find((candidate) => candidate.id === roleId);
      const knownFacts = factsForTask(task, scenario, roleId);
      const ownerLine = role !== undefined ? `\nAuthor role: ${role.label}` : '';
      const factsBlock =
        knownFacts.length > 0
          ? `\n\nKnown facts for ${role !== undefined ? `the ${role.label} role` : 'the author'}:\n- ${knownFacts.join('\n- ')}`
          : '';

      const messages: ChatMessage[] = [
        {
          role: 'system',
          content:
            'You turn a team task into a short wiki page for the team. Reply with one JSON object and nothing else: ' +
            '{"title": "...", "body": "..."}. The body is Markdown: a few headings or bullet points, plain and short. ' +
            'Use only what is in the task, its context, and any known facts below that are directly about the same topic as the task (ignore known facts about unrelated issues or other agenda items). Do not invent decisions, names, dates, numbers or placeholders such as [Insert ...]; if something is not given, leave it out. Keep the words of the task title in the title.',
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
        throw new ActionError(`Could not draft the page: ${messageOf(error)}`);
      }
      const draft = parseDraft(reply);
      if (draft === undefined) throw new ActionError('The LLM did not return usable JSON with a title and body');
      return { target: 'Wiki: meeting notes', subject: draft.title, body: draft.body };
    },
    async run(task, signal) {
      if (wiki === undefined) throw new ActionError(CONFIG_MESSAGE);
      const draft = task.draft;
      if (draft === undefined) throw new ActionError('The task has no draft to publish');

      const path = pagePath(today(), draft.subject);
      return publishPage(wiki, path, draft.subject, draft.body, `Written by Kaki: ${task.title}`, signal);
    },
  });

  return {
    name: 'action-wiki',
    start(context) {
      const stopBase = baseModule.start(context);
      // The end-of-meeting minutes are drafted locally (no LLM, no wiki call), so they are created
      // even when the wiki is unconfigured: publishing them later fails loudly on the card instead
      // of leaving the panel stuck on "syncing".

      let stopped = false;
      let transcriptLines: Array<{ speaker: string; text: string }> = [];
      let openQuestions: Question[] = [];
      let minutesPublished = false;
      let minutesTimer: ReturnType<typeof setTimeout> | undefined;

      const unsubscribe = context.hub.subscribe((event) => {
        if (stopped) return;
        if (event.type === 'MEETING_RESET') {
          transcriptLines = [];
          openQuestions = [];
          minutesPublished = false;
          if (minutesTimer !== undefined) {
            clearTimeout(minutesTimer);
            minutesTimer = undefined;
          }
          return;
        }
        if (event.type === 'TRANSCRIPT_CHUNK') {
          transcriptLines.push({ speaker: event.payload.speaker, text: event.payload.text });
          return;
        }
        if (event.type === 'MEETING_RECORD_UPDATED') {
          openQuestions = [...event.payload.openQuestions];
          return;
        }
        if (event.type === 'HOST_SPEECH_TRIGGERED' && event.payload.kind === 'CLOSING' && !minutesPublished) {
          minutesPublished = true;
          const snapshotLines = [...transcriptLines];
          minutesTimer = setTimeout(() => {
            minutesTimer = undefined;
            if (stopped) return;
            const date = today();
            // The meeting that just closed, with its own seats and agenda, not the startup scenario.
            const scenario = context.activeScenario();
            const title = `${scenario.meetingTitle} — Meeting Minutes`;
            const content = buildMeetingMinutes(
              scenario,
              date,
              snapshotLines,
              openQuestions,
              context.tasks.list(),
            );
            const assignee = minutesAssignee(scenario, context.meetingDetails?.().holders ?? []);
            if (assignee === undefined) {
              console.warn('kaki action-wiki: no human seat to review the end-of-meeting minutes; nothing was drafted');
              return;
            }
            let minutesTask: ReturnType<typeof context.tasks.suggestWithPurpose> | undefined;
            try {
              minutesTask = context.tasks.suggestWithPurpose(
                {
                  title: 'Publish meeting minutes to the team wiki',
                  context: `Full summary of ${scenario.meetingTitle} (agenda, action items, open questions, and discussion transcript).`,
                  suggestedAssignee: assignee,
                  actionKind: 'wiki_page',
                },
                'meeting_minutes',
              );
              context.tasks.transition(minutesTask.id, 'DISPATCHED', { assignee });
              context.tasks.transition(minutesTask.id, 'CLAIMED', {
                mode: 'ACTION_AGENT',
                draft: { target: 'Wiki: meeting notes', subject: title, body: content },
              });
              context.tasks.transition(minutesTask.id, 'DRAFT_READY');
            } catch (error) {
              console.warn(`kaki action-wiki: could not draft the end-of-meeting minutes: ${messageOf(error)}`);
              // The end-of-meeting card waits on this task: leave the failure visible on it, never
              // a panel stuck on "syncing".
              try {
                const id = minutesTask?.id;
                if (id !== undefined && context.tasks.get(id)?.status === 'CLAIMED') {
                  context.tasks.transition(id, 'FAILED', { error: messageOf(error) });
                }
              } catch (failure) {
                console.error('kaki action-wiki: could not mark the minutes task failed', failure);
              }
            }
          }, minutesDelayMs);
        }
      });

      return () => {
        stopped = true;
        if (minutesTimer !== undefined) clearTimeout(minutesTimer);
        unsubscribe();
        stopBase?.();
      };
    },
  };
}
