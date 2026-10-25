import type { Fact, Role, SearchCompanyData } from '@kaki/shared';
import type { Pool } from 'pg';
import { chatComplete, embedText, gatewayConfigFromEnv } from './gateway';
import { isoDay } from './dates';

const RETRIEVAL_LIMIT = 8;
const MAX_FACTS = 3;

/** A knowledge chunk returned by the vector search, with its source date. */
export interface RetrievedChunk {
  source: string;
  ref: string;
  text: string;
  publishedAt: string;
}

/** Everything the company search needs, injected so tests can use fakes. */
export interface SearchDeps {
  embed(text: string): Promise<number[]>;
  chat(prompt: string): Promise<string>;
  retrieve(embedding: number[], limit: number): Promise<RetrievedChunk[]>;
  /** Called with the retrieved chunks, so a check script can inspect the ranking. */
  onRetrieved?(chunks: RetrievedChunk[]): void;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse and strictly validate the JSON facts returned by the chat model. */
export function parseFactsResponse(raw: string): Fact[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch (error) {
    throw new Error(`Company search: model returned invalid JSON: ${raw.slice(0, 300)}`, { cause: error });
  }

  if (!isObject(parsed) || !Array.isArray(parsed.facts)) {
    throw new Error('Company search: model JSON must be an object with a "facts" array');
  }
  if (parsed.facts.length > MAX_FACTS) {
    throw new Error(`Company search: model returned ${parsed.facts.length} facts, maximum is ${MAX_FACTS}`);
  }

  return parsed.facts.map((entry, index) => {
    if (!isObject(entry)) throw new Error(`Company search: facts[${index}] must be an object`);
    const { text, source, date } = entry;
    if (typeof text !== 'string' || text.trim() === '') {
      throw new Error(`Company search: facts[${index}].text must be a non-empty string`);
    }
    if (typeof source !== 'string' || source.trim() === '') {
      throw new Error(`Company search: facts[${index}].source must be a non-empty string`);
    }
    if (typeof date !== 'string' || date.trim() === '') {
      throw new Error(`Company search: facts[${index}].date must be a non-empty string`);
    }
    return { text: text.trim(), source: source.trim(), date: date.trim() };
  });
}

function buildPrompt(question: string, role: Role, chunks: RetrievedChunk[]): string {
  const records = chunks
    .map(
      (chunk, index) =>
        `[${index + 1}] source=${chunk.source} ref=${chunk.ref} published=${isoDay(chunk.publishedAt)}\n${chunk.text}`,
    )
    .join('\n\n');

  return `A participant with the role "${role}" asked: "${question}"

Answer with facts from these company records only. Return strict JSON and nothing else:
{"facts":[{"text":"...","source":"...","date":"YYYY-MM-DD"}]}

Rules:
- Return at most ${MAX_FACTS} facts. Return {"facts":[]} when nothing in the records answers the question.
- Use only the records below. Never invent numbers, names or dates.
- If two records disagree, prefer the newest one and say so in the fact text, naming both sources and their dates. For example: "The Starfruit email (16 Nov) says the 17th; the wiki contract summary (10 Nov) still says the 20th. The newer email wins."
- Ignore records that are irrelevant to the question.
- The text must be a complete sentence a meeting participant can read.

Records:

${records}`;
}

/** Create the company search used by the Wingman knowledge module. */
export function createSearchCompanyData(deps: SearchDeps): SearchCompanyData {
  return async (question, role) => {
    const embedding = await deps.embed(question);
    const chunks = await deps.retrieve(embedding, RETRIEVAL_LIMIT);
    deps.onRetrieved?.(chunks);
    if (chunks.length === 0) return [];
    const answer = await deps.chat(buildPrompt(question, role, chunks));
    return parseFactsResponse(answer);
  };
}

interface ChunkRow {
  source: string;
  ref: string;
  text: string;
  published_at: Date | string;
}

/** Read the nearest chunks from Postgres using pgvector cosine distance. */
export async function retrieveFromPostgres(
  pool: Pool,
  embedding: number[],
  limit: number,
): Promise<RetrievedChunk[]> {
  const result = await pool.query<ChunkRow>(
    `SELECT source, ref, text, published_at
       FROM knowledge_chunks
      WHERE embedding IS NOT NULL
      ORDER BY embedding <=> $1::vector
      LIMIT $2`,
    [`[${embedding.join(',')}]`, limit],
  );
  return result.rows.map((row) => ({
    source: row.source,
    ref: row.ref,
    text: row.text,
    publishedAt: isoDay(row.published_at),
  }));
}

/** Build the search from env and a Postgres pool. */
export function createCompanySearchFromEnv(
  env: NodeJS.ProcessEnv,
  pool: Pool,
): SearchCompanyData {
  const config = gatewayConfigFromEnv(env);
  return createSearchCompanyData({
    embed: (text) => embedText(config, text),
    chat: (prompt) => chatComplete(config, prompt),
    retrieve: (embedding, limit) => retrieveFromPostgres(pool, embedding, limit),
  });
}
