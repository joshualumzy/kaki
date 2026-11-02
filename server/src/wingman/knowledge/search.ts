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

/** Parse the JSON facts returned by the chat model: bad JSON throws, an unusable fact is dropped. */
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
  // One sloppy fact (a missing source or date) must not throw away the whole answer: keep the usable ones.
  const facts: Fact[] = [];
  for (const entry of parsed.facts) {
    if (!isObject(entry)) continue;
    const { text, source, date } = entry;
    if (typeof text !== 'string' || text.trim() === '') continue;
    if (typeof source !== 'string' || source.trim() === '') continue;
    if (typeof date !== 'string' || date.trim() === '') continue;
    facts.push({ text: text.trim(), source: source.trim(), date: date.trim() });
  }
  return facts.slice(0, MAX_FACTS);
}

function buildPrompt(question: string, role: Role, chunks: RetrievedChunk[]): string {
  const records = chunks
    .map((chunk, index) => `[${index + 1}] published=${isoDay(chunk.publishedAt)}\n${chunk.text}`)
    .join('\n\n');

  return `A participant with the role "${role}" is in a live meeting and needs this answered: "${question}"

Answer with facts from the company records below. Return strict JSON and nothing else:
{"facts":[{"text":"...","source":"...","date":"YYYY-MM-DD"}]}

Rules:
- Include a fact only if it directly helps answer that question. A record about something else, even something nearby, is not a fact: leave it out. Return {"facts":[]} when nothing answers the question.
- Return the 1 to ${MAX_FACTS} most useful facts, best first. One short, plain sentence each, written for someone listening in a meeting: no ids, no jargon, no repeating the question.
- Use only the records. Never invent or round numbers, names or dates, and do not take numbers from the question itself.
- "source" is the short label in the record's first line, in plain words (for example "Wiki: Game Design Doc" or "Email from Starfruit"). Never write ids or "ref".
- "date" is the record's published date.
- Only when two records disagree about the same thing, say so in one sentence, naming both sources and dates, and say which is newer and so more likely right.

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
