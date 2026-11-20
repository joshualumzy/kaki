import { isObject, type Fact, type Role, type SearchCompanyData } from '@kaki/shared';
import type { Pool } from 'pg';
import { chatComplete, embedText, gatewayConfigFromEnv } from './gateway';
import { isoDay } from './dates';

const RETRIEVAL_LIMIT = 8;
const MAX_FACTS = 3;
/** RRF dampening constant from the original paper; larger flattens the rank gaps. */
const RRF_K = 60;

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
  retrieve(embedding: number[], question: string, limit: number): Promise<RetrievedChunk[]>;
  /** Called with the retrieved chunks, so a check script can inspect the ranking. */
  onRetrieved?(chunks: RetrievedChunk[]): void;
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
- Include a fact only if it directly helps answer that question or topic. A record about a different topic or agenda item (even from the same shop or project, such as seating/booths when the topic is the Kopi menu, or cash hygiene when the topic is butter) is not a fact: strictly leave it out. Return {"facts":[]} when nothing answers the question.
- Return the 1 to ${MAX_FACTS} most useful facts, best first. Write each as one short, crystal-clear sentence in plain everyday English that a participant can immediately understand and quote aloud to the room (for example: "Our POS system lets us keep short traditional names on kitchen tickets (1 hr setup) while showing plain-English descriptions or a 2-step Milk & Sugar pop-up on the customer screen (1.5 hr setup)."). Always include the exact numbers, dollar amounts, or setup times from the record, and avoid raw code variable names. NEVER phrase a fact as first-person advice or a pre-made meeting decision ("We can...", "We should...", "You can..."). No ids, no repeating the question.
- Use only the records. Never invent or round numbers, names or dates, and do not take numbers from the question itself.
- "source" is the short label in the record's first line, in plain words (for example "Wiki: Opening-Day Staffing Plan" or "Mattermost: #shop-floor"). Never write ids or "ref".
- "date" is the record's published date.
- Only when two records disagree about the same thing, say so in one sentence, naming both sources and dates, and say which is newer and so more likely right.

Records:

${records}`;
}

/** Create the company search used by the Wingman knowledge module. */
export function createSearchCompanyData(deps: SearchDeps): SearchCompanyData {
  return async (question, role) => {
    const embedding = await deps.embed(question);
    const chunks = await deps.retrieve(embedding, question, RETRIEVAL_LIMIT);
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

/**
 * Merge ranked lists with Reciprocal Rank Fusion, deduplicating by chunk.
 * Ties keep the order a chunk first appeared in (vector list first).
 */
export function reciprocalRankFusion(
  lists: RetrievedChunk[][],
  limit: number,
  k = RRF_K,
): RetrievedChunk[] {
  const merged = new Map<string, { chunk: RetrievedChunk; score: number; order: number }>();
  let order = 0;
  for (const list of lists) {
    list.forEach((chunk, index) => {
      const key = `${chunk.source}\u0000${chunk.ref}`;
      const contribution = 1 / (k + index + 1);
      const existing = merged.get(key);
      if (existing) {
        existing.score += contribution;
      } else {
        merged.set(key, { chunk, score: contribution, order: order++ });
      }
    });
  }
  return [...merged.values()]
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, limit)
    .map((entry) => entry.chunk);
}

function toChunks(rows: ChunkRow[]): RetrievedChunk[] {
  return rows.map((row) => ({
    source: row.source,
    ref: row.ref,
    text: row.text,
    publishedAt: isoDay(row.published_at),
  }));
}

/**
 * Read the hybrid candidates from Postgres: nearest chunks by pgvector cosine distance
 * plus full-text matches ranked by ts_rank_cd, merged with RRF.
 * A question whose full-text query has no usable words simply contributes no keyword rows.
 */
export async function retrieveFromPostgres(
  pool: Pool,
  embedding: number[],
  question: string,
  limit: number,
): Promise<RetrievedChunk[]> {
  const [vector, keyword] = await Promise.all([
    pool.query<ChunkRow>(
      `SELECT source, ref, text, published_at
         FROM knowledge_chunks
        WHERE embedding IS NOT NULL
        ORDER BY embedding <=> $1::vector
        LIMIT $2`,
      [`[${embedding.join(',')}]`, limit],
    ),
    // Questions are full sentences, so any of their words may match (OR), and chunks matching more of them
    // rank higher. The lexemes come from the same 'english' parser as text_tsv, quoted so they cast to a
    // tsquery exactly; a question with no usable words gives NULL and matches nothing.
    pool.query<ChunkRow>(
      `WITH q AS (
         SELECT (SELECT string_agg(quote_literal(lexeme), ' | ')
                   FROM unnest(tsvector_to_array(to_tsvector('english', $1))) AS lexeme)::tsquery AS query
       )
       SELECT source, ref, text, published_at
         FROM knowledge_chunks, q
        WHERE text_tsv @@ q.query
        ORDER BY ts_rank_cd(text_tsv, q.query) DESC
        LIMIT $2`,
      [question, limit],
    ),
  ]);
  return reciprocalRankFusion([toChunks(vector.rows), toChunks(keyword.rows)], limit);
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
    retrieve: (embedding, question, limit) => retrieveFromPostgres(pool, embedding, question, limit),
  });
}
