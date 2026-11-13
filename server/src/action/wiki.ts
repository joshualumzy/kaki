import { roleLabel, type Question, type Scenario, type Task } from '@kaki/shared';
import { parseJsonReply, type ChatMessage, type LlmClient } from '../llm';
import type { KakiModule } from '../modules';
import { acceptedDecisionBlock } from './draftGrounding';
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
    (task) => task.status !== 'DISMISSED' && !/^Publish meeting minutes/i.test(task.title),
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

function wikiError(message: string): ActionError {
  return new ActionError(message);
}

/** Create the module that drafts a wiki page and publishes it once the assignee approves, plus auto-publishes end-of-meeting minutes. */
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
      throw wikiError(
        timeout.aborted
          ? `The wiki timed out after ${timeoutMs} ms; check the wiki before retrying, the page may already exist`
          : `could not reach the wiki: ${plainReason(error, 'The wiki')}`,
      );
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

    const created = await graphql<{
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
    );
    const result = created.pages.create.responseResult;
    // A retry after a lost reply finds the page already there: link it rather than fail or duplicate.
    if (!result.succeeded && !/already exist/i.test(result.message ?? '')) {
      throw wikiError(`The wiki could not create the page ${path}: ${result.message ?? 'unknown error'}`);
    }
    return `${settings.url.replace(/\/+$/, '')}/en/${path}`;
  }

  const baseModule = createActionModule({
    name: 'action-wiki',
    kind: 'wiki_page',
    async draft(task, signal, scenario) {
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
          content: `Task: ${task.title}${ownerLine}\n\nContext:\n${task.context}${factsBlock}${acceptedDecisionBlock(task.decisionSource)}`,
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
      if (wiki === undefined) return stopBase;

      const shutdown = new AbortController();
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
        if (
          event.type === 'HOST_SPEECH_TRIGGERED' &&
          event.payload.kind === 'CLOSING' &&
          !minutesPublished &&
          context.draftOnly !== true
        ) {
          minutesPublished = true;
          const snapshotLines = [...transcriptLines];
          minutesTimer = setTimeout(() => {
            minutesTimer = undefined;
            if (stopped || snapshotLines.length === 0) return;
            const date = today();
            const title = `${context.scenario.meetingTitle} — Meeting Minutes`;
            const suffix = Date.now().toString(36).slice(-4);
            const path = pagePath(date, `${context.scenario.meetingTitle}-minutes-${suffix}`);
            const content = buildMeetingMinutes(
              context.scenario,
              date,
              snapshotLines,
              openQuestions,
              context.tasks.list(),
            );
            void publishPage(
              wiki,
              path,
              title,
              content,
              `End-of-meeting minutes for ${context.scenario.meetingTitle}`,
              shutdown.signal,
            )
              .then((artifactUrl) => {
                if (stopped) return;
                const facilitator =
                  context.scenario.roles.find((role) => role.facilitator === true)?.id ??
                  context.scenario.roles[0]?.id;
                if (facilitator === undefined) return;
                const minutesTask = context.tasks.suggest({
                  title: 'Publish meeting minutes to the team wiki',
                  context: `Full summary of ${context.scenario.meetingTitle} (agenda, action items, open questions, and discussion transcript).`,
                  suggestedAssignee: facilitator,
                  actionKind: 'wiki_page',
                });
                context.tasks.transition(minutesTask.id, 'DISPATCHED');
                context.tasks.transition(minutesTask.id, 'CLAIMED', { mode: 'MANUAL' });
                context.tasks.transition(minutesTask.id, 'COMPLETED', { artifactUrl });
              })
              .catch((error: unknown) => {
                if (!stopped) console.warn(`kaki action-wiki: could not publish end-of-meeting minutes: ${messageOf(error)}`);
              });
          }, minutesDelayMs);
        }
      });

      return () => {
        stopped = true;
        shutdown.abort();
        if (minutesTimer !== undefined) clearTimeout(minutesTimer);
        unsubscribe();
        stopBase?.();
      };
    },
  };
}
