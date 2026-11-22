const EMBED_TIMEOUT_MS = 120_000;
const CHAT_TIMEOUT_MS = 120_000;
const EMBED_BATCH_SIZE = 16;

/** The school gateway's OpenAI-compatible settings. */
export interface GatewayConfig {
  baseUrl: string;
  apiKey: string;
  embedBaseUrl?: string;
  embedApiKey?: string;
  chatModel: string;
  embedModel: string;
}

const DEFAULT_CHAT_MODEL = 'x-test-2';
const DEFAULT_EMBED_MODEL = 'bge-m3';

/** The missing env variable names, in the order they are reported. */
export function missingGatewayEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return ['KAKI_LLM_BASE_URL', 'KAKI_LLM_API_KEY'].filter((key) => !env[key]);
}

/** Read the gateway settings, or undefined when the keys are not configured. */
export function gatewayConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GatewayConfig | undefined {
  if (missingGatewayEnv(env).length > 0) return undefined;
  const baseUrl = (env.KAKI_LLM_BASE_URL as string).replace(/\/+$/, '');
  const apiKey = env.KAKI_LLM_API_KEY as string;
  const fallbackUrl = env.KAKI_LLM_FALLBACK_BASE_URL?.replace(/\/+$/, '');
  const fallbackKey = env.KAKI_LLM_FALLBACK_API_KEY;
  return {
    baseUrl,
    apiKey,
    embedBaseUrl: env.KAKI_EMBED_BASE_URL?.replace(/\/+$/, '') || fallbackUrl || baseUrl,
    embedApiKey: env.KAKI_EMBED_API_KEY || fallbackKey || apiKey,
    chatModel: env.KAKI_LLM_MODEL || DEFAULT_CHAT_MODEL,
    embedModel: env.KAKI_EMBED_MODEL || DEFAULT_EMBED_MODEL,
  };
}

function requireConfig(config: GatewayConfig | undefined): GatewayConfig {
  if (config === undefined) {
    throw new Error(`Company search needs KAKI_LLM_BASE_URL and KAKI_LLM_API_KEY (${missingGatewayEnv().join(', ') || 'not configured'})`);
  }
  return config;
}

async function postJson<T>(
  config: GatewayConfig,
  path: string,
  body: unknown,
  label: string,
  timeoutMs: number,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`${label}: request to ${path} failed: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${label}: HTTP ${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`${label}: response was not JSON: ${text.slice(0, 200)}`, { cause: error });
  }
}

interface EmbeddingResponse {
  data?: Array<{ embedding?: number[]; index?: number }>;
}

function isEmbedding(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === 1024 &&
    value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
  );
}

/** Embed a batch of texts with the configured model, preserving input order. */
export async function embedTexts(
  rawConfig: GatewayConfig | undefined,
  texts: string[],
): Promise<number[][]> {
  const config = requireConfig(rawConfig);
  if (texts.length === 0) return [];

  const embedConfig: GatewayConfig = {
    ...config,
    baseUrl: config.embedBaseUrl ?? config.baseUrl,
    apiKey: config.embedApiKey ?? config.apiKey,
  };
  const result: number[][] = [];
  for (let start = 0; start < texts.length; start += EMBED_BATCH_SIZE) {
    const batch = texts.slice(start, start + EMBED_BATCH_SIZE);
    const response = await postJson<EmbeddingResponse>(
      embedConfig,
      '/embeddings',
      { model: config.embedModel, input: batch, dimensions: 1024 },
      'Company search embeddings',
      EMBED_TIMEOUT_MS,
    );
    if (!Array.isArray(response.data) || response.data.length !== batch.length) {
      throw new Error(
        `Company search embeddings: expected ${batch.length} vectors, got ${response.data?.length ?? 'none'}`,
      );
    }
    const ordered = [...response.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    for (const entry of ordered) {
      if (!isEmbedding(entry.embedding)) {
        throw new Error('Company search embeddings: gateway returned an invalid 1024-dimension vector');
      }
      result.push(entry.embedding);
    }
  }
  return result;
}

/** Embed one text. */
export async function embedText(config: GatewayConfig | undefined, text: string): Promise<number[]> {
  const [embedding] = await embedTexts(config, [text]);
  if (embedding === undefined) throw new Error('Company search embeddings: gateway returned no vector');
  return embedding;
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

/** Ask the chat model for a completion and return its text. */
export async function chatComplete(
  rawConfig: GatewayConfig | undefined,
  prompt: string,
  system = 'You answer questions about a fictional company using only the supplied records.',
): Promise<string> {
  const config = requireConfig(rawConfig);
  const response = await postJson<ChatResponse>(
    config,
    '/chat/completions',
    {
      model: config.chatModel,
      temperature: 0,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    },
    'Company search chat',
    CHAT_TIMEOUT_MS,
  );
  const content = response.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim() === '') {
    throw new Error('Company search chat: gateway returned no message content');
  }
  return content;
}
