/** One chat message sent to the model. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Options for one completion call. */
export interface CompleteOptions {
  /** Ask the model for a single JSON object. */
  json?: boolean;
  signal?: AbortSignal;
  /** Sampling temperature; defaults to 0 so analysis is repeatable. Conversation wants more. */
  temperature?: number;
  /** Optional reasoning effort override for models that support it (e.g. 'none' on DeepSeek for fast classification). */
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
  /** Output token ceiling for bounded paid calls. */
  maxTokens?: number;
}

export interface CompletionUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface OpenAiLlm extends LlmClient {
  completeWithUsage(messages: ChatMessage[], options?: CompleteOptions): Promise<{ content: string; usage?: CompletionUsage }>;
}

/** The shared LLM client every module uses; the fake one stands in for it in tests. */
export interface LlmClient {
  complete(messages: ChatMessage[], options?: CompleteOptions): Promise<string>;
  /** The reply as it is written, piece by piece; absent on clients that cannot stream. */
  stream?(messages: ChatMessage[], options?: CompleteOptions): AsyncIterable<string>;
  /** The backup model on its own, so a caller can go straight to it after a stalled first sentence. */
  fallbackStream?(messages: ChatMessage[], options?: CompleteOptions): AsyncIterable<string>;
}

/** An LLM call that failed: HTTP error, timeout, or an unusable reply. */
export class LlmError extends Error {}

/** Settings for an OpenAI-compatible chat completions endpoint (such as the school gateway). */
export interface OpenAiLlmOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Whole-request timeout for `complete`; streaming uses the chunk deadlines below instead. */
  timeoutMs?: number;
  /** How long a stream waits for its first content chunk. */
  firstChunkMs?: number;
  /** How long a stream waits between content chunks before it is treated as stalled. */
  idleMs?: number;
  /** Generous whole-reply safety cap for a stream, so a slow trickle cannot run forever. */
  streamSafetyMs?: number;
  fetchImpl?: typeof fetch;
  /**
   * Whether the model accepts `reasoning_effort`. Unset keeps the old rule: only model names
   * containing "deepseek". Set it explicitly when the same model is served under another name.
   */
  reasoningControl?: boolean;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_FIRST_CHUNK_MS = 12_000;
const DEFAULT_IDLE_MS = 10_000;
const DEFAULT_STREAM_SAFETY_MS = 60_000;

/** Read a positive whole number, and name the variable in the error when it is malformed. */
function positiveIntegerFromEnv(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`Invalid ${name}: ${raw}`);
  return value;
}

/** Read a true/false (or 1/0) switch, and name the variable in the error when it is malformed. */
export function reasoningControlFromEnv(raw: string | undefined, name: string): boolean | undefined {
  if (raw === undefined) return undefined;
  switch (raw.trim().toLowerCase()) {
    case 'true':
    case '1':
      return true;
    case 'false':
    case '0':
      return false;
    default:
      throw new Error(`Invalid ${name}: ${raw} (expected true/false or 1/0)`);
  }
}

/** The single warning logged when the fallback takes over; it never includes URLs, keys or headers. */
function fallbackWarning(primaryModel: string, error: unknown, fallbackModel: string): string {
  const detail = (error instanceof Error ? error.message : String(error)).slice(0, 200);
  return `[llm-fallback] primary ${primaryModel} failed: ${detail}; using ${fallbackModel}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse a JSON reply, dropping any Markdown code fence the model wrapped around it. */
export function parseJsonReply(text: string): unknown {
  const match = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(text);
  return JSON.parse((match === null ? text : match[1]!).trim());
}

// Pull choices[0].message.content out of a chat completions reply.
function contentOf(body: unknown): string | undefined {
  if (!isObject(body) || !Array.isArray(body.choices)) return undefined;
  const [first] = body.choices as unknown[];
  if (!isObject(first) || !isObject(first.message)) return undefined;
  return typeof first.message.content === 'string' ? first.message.content : undefined;
}

function usageOf(body: unknown): CompletionUsage | undefined {
  if (!isObject(body) || !isObject(body.usage)) return undefined;
  const { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens } = body.usage;
  if (![promptTokens, completionTokens, totalTokens].every((n) => Number.isSafeInteger(n) && (n as number) >= 0)) return undefined;
  return { promptTokens: promptTokens as number, completionTokens: completionTokens as number, totalTokens: totalTokens as number };
}

interface StreamDelta {
  content?: string;
  /** Some gateways stream the model's thinking in its own field before any answer. */
  reasoning?: string;
  finishReason?: string;
}

// Pull the useful parts of one streamed chunk.
function deltaOf(chunk: unknown): StreamDelta | undefined {
  if (!isObject(chunk) || !Array.isArray(chunk.choices)) return undefined;
  const [first] = chunk.choices as unknown[];
  if (!isObject(first)) return undefined;
  const delta = isObject(first.delta) ? first.delta : {};
  return {
    content: typeof delta.content === 'string' ? delta.content : undefined,
    reasoning: typeof delta.reasoning_content === 'string' ? delta.reasoning_content
      : typeof delta.reasoning === 'string' ? delta.reasoning : undefined,
    finishReason: typeof first.finish_reason === 'string' ? first.finish_reason : undefined,
  };
}

// A gateway can report a failure inside a 200 SSE stream instead of an HTTP error.
function streamErrorOf(chunk: unknown): string | undefined {
  if (!isObject(chunk) || !isObject(chunk.error)) return undefined;
  const message = chunk.error.message;
  return typeof message === 'string' && message.trim() !== '' ? message : 'unknown error';
}

/**
 * The `data:` payloads of a server-sent-events body, however the network cuts it up. Handles
 * both line endings, comment lines, and `data:` with or without a space after the colon.
 */
export async function* serverSentData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const dataOf = (line: string): string | undefined =>
    line.startsWith('data:') ? line.slice(5).replace(/^ /, '') : undefined;

  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r\n|\n|\r(?!\n)/);
      buffer = done ? '' : (lines.pop() ?? '');
      for (const line of done ? lines.concat(buffer) : lines) {
        const data = dataOf(line);
        if (data !== undefined && data.length > 0) yield data;
      }
      if (done) return;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** Create a client for an OpenAI-compatible `/chat/completions` endpoint. */
export function createOpenAiLlm({
  baseUrl,
  apiKey,
  model,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  firstChunkMs = DEFAULT_FIRST_CHUNK_MS,
  idleMs = DEFAULT_IDLE_MS,
  streamSafetyMs = DEFAULT_STREAM_SAFETY_MS,
  fetchImpl = fetch,
  reasoningControl,
}: OpenAiLlmOptions): OpenAiLlm {
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const controlReasoning = reasoningControl ?? /deepseek/i.test(model);
  // Not every OpenAI-compatible model accepts response_format; stop sending it once one refuses.
  let jsonModeSupported = true;

  async function post(body: Record<string, unknown>, signal: AbortSignal, failureReason: () => string | undefined): Promise<Response> {
    try {
      return await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      const reason = failureReason() ?? String(error);
      throw new LlmError(`LLM request failed: ${reason}`, { cause: error });
    }
  }

  async function completeWithUsage(messages: ChatMessage[], options: CompleteOptions = {}): Promise<{ content: string; usage?: CompletionUsage }> {
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal]);
      const effort = options.reasoningEffort ?? (options.json === true && controlReasoning ? 'none' : undefined);
      const request = {
        model,
        messages,
        temperature: options.temperature ?? 0,
        ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
        ...(controlReasoning && effort !== undefined ? { reasoning_effort: effort } : {}),
      };
      const askForJson = options.json === true && jsonModeSupported;

      let response = await post(
        askForJson ? { ...request, response_format: { type: 'json_object' } } : request,
        signal,
        () => (timeout.aborted ? `timed out after ${timeoutMs} ms` : undefined),
      );
      let detail = response.ok ? '' : (await response.text().catch(() => '')).slice(0, 200);
      if (askForJson && response.status === 400 && detail.includes('response_format')) {
        jsonModeSupported = false;
        response = await post(request, signal, () => (timeout.aborted ? `timed out after ${timeoutMs} ms` : undefined));
        detail = response.ok ? '' : (await response.text().catch(() => '')).slice(0, 200);
      }

      if (!response.ok) {
        throw new LlmError(`LLM request failed with HTTP ${response.status}: ${detail}`);
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        throw new LlmError('LLM reply is not valid JSON', { cause: error });
      }
      const content = contentOf(body);
      if (content === undefined) throw new LlmError('LLM reply has no message content');
      return { content, usage: usageOf(body) };
  }

  return {
    completeWithUsage,
    async complete(messages, options) { return (await completeWithUsage(messages, options)).content; },
    async *stream(messages, options = {}) {
      const deadline = new AbortController();
      let deadlineReason: string | undefined;
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      const clearDeadline = (): void => {
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
        deadlineTimer = undefined;
      };
      const armDeadline = (ms: number, reason: string): void => {
        clearDeadline();
        deadlineTimer = setTimeout(() => {
          deadlineReason = reason;
          deadline.abort();
        }, ms);
        deadlineTimer.unref?.();
      };
      const overallTimer = setTimeout(() => {
        if (deadline.signal.aborted) return;
        deadlineReason = `the reply took longer than ${streamSafetyMs} ms`;
        deadline.abort();
      }, streamSafetyMs);
      overallTimer.unref?.();
      const signal = AbortSignal.any(options.signal === undefined ? [deadline.signal] : [deadline.signal, options.signal]);
      const isBoundedAssessment =
        controlReasoning &&
        messages[0]?.role === 'system' &&
        messages[0].content.includes('[KAKI_PROPOSAL_ASSESSMENT]');
      const effort = options.reasoningEffort ?? (isBoundedAssessment ? 'none' : undefined);
      const request = {
        model,
        messages,
        temperature: options.temperature ?? 0,
        stream: true,
        ...(controlReasoning && effort !== undefined ? { reasoning_effort: effort } : {}),
      };

      let firstChunkSeen = false;
      let sawContent = false;
      let sawReasoning = false;
      let finishReason: string | undefined;
      try {
        armDeadline(firstChunkMs, `the first chunk did not arrive within ${firstChunkMs} ms`);
        const response = await post(request, signal, () => (deadline.signal.aborted ? deadlineReason : undefined));
        if (!response.ok) {
          const detail = (await response.text().catch(() => '')).slice(0, 200);
          throw new LlmError(`LLM request failed with HTTP ${response.status}: ${detail}`);
        }
        if (response.body === null) throw new LlmError('LLM reply has no body');

        const chunks = serverSentData(response.body)[Symbol.asyncIterator]();
        const finish = (): void => {
          if (sawContent) return;
          throw new LlmError(
            sawReasoning
              ? `LLM stream ended without content (reasoning only${finishReason === undefined ? '' : `, finish_reason=${finishReason}`})`
              : `LLM stream ended without content${finishReason === undefined ? '' : ` (finish_reason=${finishReason})`}`,
          );
        };
        for (;;) {
          if (firstChunkSeen) armDeadline(idleMs, `the reply stalled for ${idleMs} ms between chunks`);
          const next = await chunks.next();
          if (next.done === true) {
            finish();
            return;
          }
          const data = next.value;
          if (data === '[DONE]') {
            finish();
            return;
          }
          let piece: unknown;
          try {
            piece = JSON.parse(data);
          } catch {
            continue; // a keep-alive or a partial line the gateway garbled: skip it
          }
          const streamError = streamErrorOf(piece);
          if (streamError !== undefined) throw new LlmError(`LLM stream error: ${streamError}`);
          const delta = deltaOf(piece);
          if (delta === undefined) continue;
          if (delta.finishReason !== undefined) finishReason = delta.finishReason;
          if (delta.reasoning !== undefined && delta.reasoning.length > 0) {
            // Thinking is progress: keep the stream alive, but never say it aloud.
            clearDeadline();
            firstChunkSeen = true;
            sawReasoning = true;
          }
          if (delta.content === undefined || delta.content.length === 0) continue;
          // Do not run the gap timer while the caller is playing what we just gave it.
          clearDeadline();
          firstChunkSeen = true;
          sawContent = true;
          yield delta.content;
        }
      } catch (error) {
        if (error instanceof LlmError) throw error;
        // The caller stopping the stream is not a failure; anything else is.
        if (options.signal?.aborted === true) return;
        const reason = deadline.signal.aborted && deadlineReason !== undefined ? deadlineReason : String(error);
        throw new LlmError(`LLM stream failed: ${reason}`, { cause: error });
      } finally {
        clearDeadline();
        clearTimeout(overallTimer);
      }
    },
  };
}

/** A scripted LLM for tests: records every call and answers with `respond`. */
export interface FakeLlm extends LlmClient {
  calls: ChatMessage[][];
}

/** Create a fake LLM; `respond` may return text or throw to simulate an outage. */
export function createFakeLlm(
  respond: (messages: ChatMessage[], call: number) => string | Promise<string>,
): FakeLlm {
  const calls: ChatMessage[][] = [];
  return {
    calls,
    async complete(messages) {
      calls.push(messages);
      return respond(messages, calls.length - 1);
    },
  };
}

/**
 * Build the client from KAKI_LLM_BASE_URL, KAKI_LLM_API_KEY and KAKI_LLM_MODEL.
 * If KAKI_LLM_FALLBACK_BASE_URL, KAKI_LLM_FALLBACK_API_KEY and KAKI_LLM_FALLBACK_MODEL are also set,
 * automatically retries on the fallback LLM whenever the primary LLM fails (e.g. out of credits / HTTP 402/429/5xx).
 * Returns undefined when any primary var is missing, so callers can run without an LLM.
 */
export function llmFromEnv(env: NodeJS.ProcessEnv = process.env): LlmClient | undefined {
  const baseUrl = env.KAKI_LLM_BASE_URL;
  const apiKey = env.KAKI_LLM_API_KEY;
  const model = env.KAKI_LLM_MODEL;
  if (!baseUrl || !apiKey || !model) return undefined;

  const rawTimeout = env.KAKI_LLM_TIMEOUT_MS;
  const timeoutMs = positiveIntegerFromEnv(rawTimeout, 'KAKI_LLM_TIMEOUT_MS');
  const firstChunkMs = positiveIntegerFromEnv(env.KAKI_LLM_FIRST_CHUNK_MS, 'KAKI_LLM_FIRST_CHUNK_MS');
  const idleMs = positiveIntegerFromEnv(env.KAKI_LLM_IDLE_MS, 'KAKI_LLM_IDLE_MS');
  const primary = createOpenAiLlm({
    baseUrl,
    apiKey,
    model,
    timeoutMs,
    firstChunkMs,
    idleMs,
    reasoningControl: reasoningControlFromEnv(env.KAKI_LLM_REASONING_CONTROL, 'KAKI_LLM_REASONING_CONTROL'),
  });

  const fallbackBaseUrl = env.KAKI_LLM_FALLBACK_BASE_URL;
  const fallbackApiKey = env.KAKI_LLM_FALLBACK_API_KEY;
  const fallbackModel = env.KAKI_LLM_FALLBACK_MODEL;
  if (!fallbackBaseUrl || !fallbackApiKey || !fallbackModel) return primary;

  const fallback = createOpenAiLlm({
    baseUrl: fallbackBaseUrl,
    apiKey: fallbackApiKey,
    model: fallbackModel,
    timeoutMs,
    firstChunkMs,
    idleMs,
    reasoningControl: reasoningControlFromEnv(
      env.KAKI_LLM_FALLBACK_REASONING_CONTROL,
      'KAKI_LLM_FALLBACK_REASONING_CONTROL',
    ),
  });

  return {
    async complete(messages, options) {
      try {
        return await primary.complete(messages, options);
      } catch (error) {
        if (options?.signal?.aborted === true) throw error;
        console.warn(fallbackWarning(model, error, fallbackModel));
        return await fallback.complete(messages, options);
      }
    },
    ...(fallback.stream === undefined ? {} : {
      fallbackStream(messages: ChatMessage[], options?: CompleteOptions): AsyncIterable<string> {
        return fallback.stream!(messages, options);
      },
    }),
    async *stream(messages, options) {
      if (primary.stream === undefined) {
        if (fallback.stream !== undefined) yield* fallback.stream(messages, options);
        return;
      }
      let yieldedAny = false;
      try {
        for await (const chunk of primary.stream(messages, options)) {
          yieldedAny = true;
          yield chunk;
        }
      } catch (error) {
        if (yieldedAny || options?.signal?.aborted === true || fallback.stream === undefined) throw error;
        console.warn(fallbackWarning(model, error, fallbackModel));
        yield* fallback.stream(messages, options);
      }
    },
  };
}

/**
 * The notetaker's client. It runs in the background, so it can use a dedicated model or gateway
 * separate from the real-time voice NPCs: KAKI_NOTETAKER_LLM_BASE_URL, KAKI_NOTETAKER_LLM_API_KEY,
 * KAKI_NOTETAKER_LLM_MODEL, and KAKI_NOTETAKER_LLM_TIMEOUT_MS override the shared KAKI_LLM_* settings.
 * When KAKI_NOTETAKER_LLM_MODEL targets a non-DeepSeek model (such as qwen3.6:35b) and KAKI_LLM_FALLBACK_*
 * is configured, it automatically routes the notetaker to the fallback gateway unless KAKI_NOTETAKER_LLM_BASE_URL is set.
 */
export function notetakerLlmFromEnv(env: NodeJS.ProcessEnv = process.env): LlmClient | undefined {
  const notetakerModel = env.KAKI_NOTETAKER_LLM_MODEL || env.KAKI_LLM_MODEL;
  const useFallbackGatewayForNotetaker =
    !env.KAKI_NOTETAKER_LLM_BASE_URL &&
    notetakerModel !== undefined &&
    !/deepseek/i.test(notetakerModel) &&
    /deepseek/i.test(env.KAKI_LLM_BASE_URL ?? '') &&
    Boolean(env.KAKI_LLM_FALLBACK_BASE_URL && env.KAKI_LLM_FALLBACK_API_KEY);
  // The switch belongs to a model, not a gateway: the notetaker's model may differ from the gateway's
  // usual one, so only its own switch applies (unset: the model-name default in createOpenAiLlm).
  const reasoningControl = reasoningControlFromEnv(
    env.KAKI_NOTETAKER_LLM_REASONING_CONTROL,
    'KAKI_NOTETAKER_LLM_REASONING_CONTROL',
  );
  return llmFromEnv({
    ...env,
    KAKI_LLM_BASE_URL:
      env.KAKI_NOTETAKER_LLM_BASE_URL ||
      (useFallbackGatewayForNotetaker ? env.KAKI_LLM_FALLBACK_BASE_URL : env.KAKI_LLM_BASE_URL),
    KAKI_LLM_API_KEY:
      env.KAKI_NOTETAKER_LLM_API_KEY ||
      (useFallbackGatewayForNotetaker ? env.KAKI_LLM_FALLBACK_API_KEY : env.KAKI_LLM_API_KEY),
    KAKI_LLM_MODEL: notetakerModel,
    KAKI_LLM_TIMEOUT_MS: env.KAKI_NOTETAKER_LLM_TIMEOUT_MS || env.KAKI_LLM_TIMEOUT_MS,
    KAKI_LLM_REASONING_CONTROL: reasoningControl === undefined ? undefined : String(reasoningControl),
  });
}
