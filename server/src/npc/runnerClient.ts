import {
  isRunnerMeetingSnapshot,
  parseScenario,
  type KakiEvent,
  type MeetingMemoryEntry,
  type RunnerMeetingSnapshot,
  type Scenario,
  type SuggestInput,
} from '@kaki/shared';
import { postMeetingMemory, postSettledTopic } from './settlement';

/**
 * The AI runner's one HTTP client. Every read and write goes through it, so the service token is
 * attached in exactly one place and a route that needs it cannot be called without it.
 */
interface RunnerClient {
  emit(event: KakiEvent): Promise<Response>;
  postHumanLine(line: {
    meetingId: string;
    participantIdentity: string;
    seat: string;
    text: string;
    source: 'speech' | 'typed';
    clientLineId: string;
    speechStartedAt?: string;
    speechEndedAt?: string;
    overlap?: boolean;
  }): Promise<Response>;
  suggestTask(input: SuggestInput): Promise<Response>;
  postMeetingMemory(entries: readonly MeetingMemoryEntry[]): Promise<void>;
  postSettledTopic(followUp: SuggestInput, reopened?: boolean): Promise<void>;
  fetchMeetingState(): Promise<RunnerMeetingSnapshot>;
  fetchScenario(): Promise<Scenario>;
}

interface RunnerClientOptions {
  baseUrl: string;
  /**
   * The meeting's API prefix: empty for the legacy meeting (today's `/api/runner/...`), or
   * `/api/meetings/<id>` for a real meeting (whose runner routes are `/api/meetings/<id>/runner/...`).
   */
  apiPrefix?: string;
  serviceToken?: string | undefined;
  fetch?: typeof fetch;
  log?: (message: string) => void;
  /** How many times a human line is posted before it is dropped (default 3). */
  humanLineAttempts?: number;
  /** Base backoff between human-line attempts; it doubles each time (default 1000 ms). */
  humanLineRetryBaseMs?: number;
  /** Injected by tests so retries do not wait. */
  sleep?: (ms: number) => Promise<void>;
}

/** Builds the HTTP client the runner uses to post human lines and follow-ups to the server. */
export function createRunnerClient({
  baseUrl,
  apiPrefix = '',
  serviceToken,
  fetch: fetchImpl = fetch,
  log = () => undefined,
  humanLineAttempts = 3,
  humanLineRetryBaseMs = 1_000,
  sleep = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
}: RunnerClientOptions): RunnerClient {
  const base = baseUrl.replace(/\/+$/, '');
  const apiRoot = apiPrefix === '' ? '/api' : apiPrefix;
  const authorization: Record<string, string> =
    serviceToken === undefined || serviceToken === ''
      ? {}
      : { authorization: `Bearer ${serviceToken}` };
  const request = (url: string, init: RequestInit = {}): Promise<Response> =>
    fetchImpl(url, {
      ...init,
      headers: {
        ...authorization,
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  const postJson = (path: string, body: unknown): Promise<Response> =>
    request(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  /** A 409 the server marks retryable is a race (for example the meeting is still starting). */
  async function isRetryableConflict(response: Response): Promise<boolean> {
    if (response.status !== 409) return false;
    const body = (await response.clone().json().catch(() => undefined)) as
      | { retryable?: unknown }
      | undefined;
    return body?.retryable === true;
  }

  /**
   * One recognised line, retried with the same id: the server's dedupe makes every retry safe.
   * Network errors and a retryable 409 are transient; anything else is the server's final answer.
   */
  async function postHumanLine(line: Parameters<RunnerClient['postHumanLine']>[0]): Promise<Response> {
    let attempt = 1;
    for (;;) {
      try {
        const response = await postJson(`${apiRoot}/runner/human-line`, line);
        if (response.ok || attempt >= humanLineAttempts || !(await isRetryableConflict(response))) {
          return response;
        }
        log(`Kaki did not take a recognised line yet (HTTP ${response.status}); retrying`);
      } catch (error) {
        if (attempt >= humanLineAttempts) throw error;
        log(`could not reach Kaki with a recognised line (${String(error)}); retrying`);
      }
      await sleep(humanLineRetryBaseMs * 2 ** (attempt - 1));
      attempt += 1;
    }
  }

  return {
    emit: (event) => postJson(`${apiRoot}/runner/emit`, event),
    postHumanLine,
    suggestTask: (input) => postJson(`${apiRoot}/runner/suggest-task`, input),
    postMeetingMemory: (entries) =>
      postMeetingMemory(request, `${base}${apiRoot}/runner/meeting-memory`, entries, log),
    postSettledTopic: (followUp, reopened = false) =>
      postSettledTopic(request, `${base}${apiRoot}/runner/settle-topic`, followUp, log, reopened),
    async fetchMeetingState() {
      const response = await request(`${base}${apiRoot}/runner/meeting-state`);
      if (!response.ok) throw new Error(`meeting state fetch returned HTTP ${response.status}`);
      const state: unknown = await response.json().catch(() => undefined);
      if (!isRunnerMeetingSnapshot(state)) {
        throw new Error('meeting state is not a runner meeting snapshot');
      }
      return state;
    },
    async fetchScenario() {
      const response = await request(`${base}${apiRoot}/scenario/full`);
      if (!response.ok) {
        throw new Error(
          `Scenario fetch returned HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`,
        );
      }
      return parseScenario(await response.json(), { requireOrganisation: false });
    },
  };
}
