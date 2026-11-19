import { parseScenario, type KakiEvent, type MeetingMemoryEntry, type Scenario, type SuggestInput } from '@kaki/shared';
import type { RunnerMeetingState } from './runner';
import { postMeetingMemory, postSettledTopic } from './settlement';

/**
 * The AI runner's one HTTP client. Every read and write goes through it, so the service token is
 * attached in exactly one place and a route that needs it cannot be called without it.
 */
export interface RunnerClient {
  emit(event: KakiEvent): Promise<Response>;
  suggestTask(input: SuggestInput): Promise<Response>;
  postMeetingMemory(entries: readonly MeetingMemoryEntry[]): Promise<void>;
  postSettledTopic(followUp: SuggestInput, reopened?: boolean): Promise<void>;
  fetchMeetingState(): Promise<RunnerMeetingState>;
  fetchScenario(): Promise<Scenario>;
}

export interface RunnerClientOptions {
  baseUrl: string;
  serviceToken?: string | undefined;
  fetch?: typeof fetch;
  log?: (message: string) => void;
}

export function createRunnerClient({
  baseUrl,
  serviceToken,
  fetch: fetchImpl = fetch,
  log = () => undefined,
}: RunnerClientOptions): RunnerClient {
  const base = baseUrl.replace(/\/+$/, '');
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

  return {
    emit: (event) => postJson('/api/runner/emit', event),
    suggestTask: (input) => postJson('/api/runner/suggest-task', input),
    postMeetingMemory: (entries) =>
      postMeetingMemory(request, `${base}/api/runner/meeting-memory`, entries, log),
    postSettledTopic: (followUp, reopened = false) =>
      postSettledTopic(request, `${base}/api/runner/settle-topic`, followUp, log, reopened),
    async fetchMeetingState() {
      const response = await request(`${base}/api/runner/meeting-state`);
      const state = (await response.json().catch(() => ({}))) as {
        meetingId?: unknown;
        started?: unknown;
        agendaIndex?: unknown;
      };
      if (!response.ok) throw new Error(`meeting state fetch returned HTTP ${response.status}`);
      if (
        typeof state.meetingId !== 'string' ||
        state.meetingId === '' ||
        typeof state.started !== 'boolean'
      ) {
        throw new Error('meeting state has no meetingId and started flag');
      }
      return {
        meetingId: state.meetingId,
        started: state.started,
        ...(typeof state.agendaIndex === 'number' ? { agendaIndex: state.agendaIndex } : {}),
      };
    },
    async fetchScenario() {
      const response = await request(`${base}/api/scenario/full`);
      if (!response.ok) {
        throw new Error(
          `Scenario fetch returned HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`,
        );
      }
      return parseScenario(await response.json());
    },
  };
}
