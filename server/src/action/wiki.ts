import { parseJsonReply, type ChatMessage, type LlmClient } from '../llm';
import type { KakiModule } from '../modules';
import { ActionError, createActionModule, isObject, messageOf, plainReason } from './runner';

const DEFAULT_TIMEOUT_MS = 10_000;

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
  /** Today's date as YYYY-MM-DD; tests fix it. */
  today?: () => string;
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

/** Create the module that drafts a wiki page and publishes it once the assignee approves. */
export function createWikiModule({
  llm,
  wiki,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  today = () => new Date().toISOString().slice(0, 10),
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

  return createActionModule({
    name: 'action-wiki',
    kind: 'wiki_page',
    async draft(task, signal) {
      if (wiki === undefined) throw new ActionError(CONFIG_MESSAGE);
      if (llm === undefined) throw new ActionError('The LLM is not configured, so the page cannot be drafted');

      const messages: ChatMessage[] = [
        {
          role: 'system',
          content:
            'You turn a team task into a short wiki page for the team. Reply with one JSON object and nothing else: ' +
            '{"title": "...", "body": "..."}. The body is Markdown: a few headings or bullet points, plain and short. ' +
            'Use only what is in the task and its context. Do not invent decisions, names, dates, numbers or placeholders such as [Insert ...]; if something is not given, leave it out. Keep the words of the task title in the title.',
        },
        { role: 'user', content: `Task: ${task.title}\n\nContext:\n${task.context}` },
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

      const login = await graphql<{
        authentication: { login: { jwt?: string; responseResult: { succeeded: boolean; message?: string } } };
      }>(
        wiki,
        `mutation Login($username: String!, $password: String!, $strategy: String!) {
          authentication { login(username: $username, password: $password, strategy: $strategy) {
            jwt responseResult { succeeded message } } }
        }`,
        { username: wiki.email, password: wiki.password, strategy: 'local' },
        signal,
      );
      const auth = login.authentication.login;
      if (!auth.responseResult.succeeded || auth.jwt === undefined) {
        throw wikiError(`The wiki rejected the login: ${auth.responseResult.message ?? 'no token returned'}`);
      }

      const path = pagePath(today(), draft.subject);
      const created = await graphql<{
        pages: { create: { responseResult: { succeeded: boolean; message?: string } } };
      }>(
        wiki,
        `mutation Create($content: String!, $description: String!, $path: String!, $title: String!) {
          pages { create(content: $content, description: $description, editor: "markdown",
            isPublished: true, isPrivate: false, locale: "en", path: $path, tags: [], title: $title) {
            responseResult { succeeded message } } }
        }`,
        { content: draft.body, description: `Written by Kaki: ${task.title}`.slice(0, 200), path, title: draft.subject },
        signal,
        auth.jwt,
      );
      const result = created.pages.create.responseResult;
      // A retry after a lost reply finds the page already there: link it rather than fail or duplicate.
      if (!result.succeeded && !/already exist/i.test(result.message ?? '')) {
        throw wikiError(`The wiki could not create the page ${path}: ${result.message ?? 'unknown error'}`);
      }
      return `${wiki.url.replace(/\/+$/, '')}/en/${path}`;
    },
  });
}
