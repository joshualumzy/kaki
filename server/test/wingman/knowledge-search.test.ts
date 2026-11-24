import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  MIN_VECTOR_SIMILARITY,
  createSearchCompanyData,
  parseFactsResponse,
  reciprocalRankFusion,
  retrieveFromPostgres,
  type RetrievedChunk,
  type SearchDeps,
} from '../../src/wingman/knowledge/search';

const chunks: RetrievedChunk[] = [
  {
    source: 'mail',
    ref: '<anchor-butter-price@example>',
    text: '[Mail: Anchor butter price notice, 16 Nov 2026]\n\nWholesale Anchor salted butter rose 35% this month.',
    publishedAt: '2026-11-16',
  },
  {
    source: 'wiki',
    ref: 'kopitiam/delivery-pricing#1-commission',
    text: '[Wiki: Nanyang Kopi & Toast - Delivery Pricing, updated 10 Nov 2026]\n\nThe delivery app takes 32% of every order.',
    publishedAt: '2026-11-10',
  },
];

function deps(overrides: Partial<SearchDeps> = {}): SearchDeps {
  return {
    embed: async () => [0.1, 0.2],
    chat: async () =>
      JSON.stringify({
        facts: [
          {
            text: 'The Anchor butter email (16 Nov) says 35%; the delivery pricing page says the app takes 32%. Both matter.',
            source: 'Anchor butter email and delivery pricing page',
            date: '2026-11-16',
          },
        ],
      }),
    retrieve: async () => chunks,
    ...overrides,
  };
}

describe('company search', () => {
  it('embeds, retrieves, prompts with the sources and returns validated facts', async () => {
    const requests: string[] = [];
    let embedded: string | undefined;
    let retrievedLimit: number | undefined;
    const search = createSearchCompanyData(
      deps({
        embed: async (text) => {
          embedded = text;
          return [0.1, 0.2];
        },
        retrieve: async (_embedding, _question, limit) => {
          retrievedLimit = limit;
          return chunks;
        },
        chat: async (prompt) => {
          requests.push(prompt);
          return JSON.stringify({
            facts: [
              {
                text: 'Anchor butter email (16 Nov) says 35%; the delivery pricing page says the app takes 32%. Both matter.',
                source: 'Anchor butter email; delivery pricing page',
                date: '2026-11-16',
              },
            ],
          });
        },
      }),
    );

    const facts = await search('How much does delivery commission cost us?', 'operations_director');

    expect(embedded).toBe('How much does delivery commission cost us?');
    expect(retrievedLimit).toBe(8);
    expect(requests[0]).toContain('operations_director');
    expect(requests[0]).toContain('Anchor butter price notice');
    expect(requests[0]).toContain('published=2026-11-10');
    expect(facts).toHaveLength(1);
    expect(facts[0]?.source).toContain('Anchor');
  });

  it('allows an empty fact list when nothing is relevant', async () => {
    const search = createSearchCompanyData(deps({ chat: async () => '{"facts":[]}' }));
    expect(await search('What is for lunch?', 'operations_director')).toEqual([]);
  });

  it('returns no facts without calling the model when nothing is retrieved', async () => {
    let called = false;
    const search = createSearchCompanyData(
      deps({
        retrieve: async () => [],
        chat: async () => {
          called = true;
          return '{"facts":[]}';
        },
      }),
    );
    expect(await search('Unknown', 'operations_director')).toEqual([]);
    expect(called).toBe(false);
  });

  it('rejects malformed model output instead of guessing', () => {
    expect(() => parseFactsResponse('not json')).toThrow(/invalid JSON/);
    expect(() => parseFactsResponse('{"answer":[]}')).toThrow(/"facts" array/);
  });

  it('drops a fact with no source or date but keeps the good ones, and caps at three', () => {
    const good = { text: 'ok', source: 's', date: '2026-11-10' };
    expect(
      parseFactsResponse(
        JSON.stringify({
          facts: [{ ...good, source: '' }, { ...good, date: undefined }, 7, good],
        }),
      ),
    ).toEqual([good]);
    expect(
      parseFactsResponse(JSON.stringify({ facts: [1, 2, 3, 4].map((i) => ({ ...good, text: `f${i}` })) })),
    ).toHaveLength(3);
  });
});

function chunk(ref: string): RetrievedChunk {
  return { source: 'wiki', ref, text: ref, publishedAt: '2026-11-10' };
}

describe('reciprocal rank fusion', () => {
  it('orders chunks by RRF score (k=60), best score first', () => {
    const a = chunk('a');
    const b = chunk('b');
    const c = chunk('c');
    expect(reciprocalRankFusion([[a, b], [b, c]], 3)).toEqual([b, a, c]);
  });

  it('keeps a chunk found only by its exact keywords in the top list', () => {
    const semantic = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'].map(chunk);
    const exactFigure = chunk('launch_budget/1');
    const fused = reciprocalRankFusion([semantic, [exactFigure]], 8);
    expect(fused.map((entry) => entry.ref)).toContain('launch_budget/1');
    expect(fused).toHaveLength(8);
  });

  it('lists a chunk found by both queries once', () => {
    const both = chunk('both');
    const fused = reciprocalRankFusion([[both], [both]], 8);
    expect(fused).toEqual([both]);
  });

  it('falls back to the vector list when the full-text query finds nothing', () => {
    const vector = [chunk('a'), chunk('b')];
    expect(reciprocalRankFusion([vector, []], 8)).toEqual(vector);
  });
});

interface SearchRow {
  source: string;
  ref: string;
  text: string;
  published_at: string;
  similarity?: number;
  distance?: number;
}

function searchRow(ref: string, score: { similarity?: number; distance?: number }): SearchRow {
  return { source: 'wiki', ref, text: ref, published_at: '2026-11-10', ...score };
}

function postgresDouble(vector: SearchRow[], keyword: SearchRow[]): Pool {
  return {
    query: async (text: string) => ({ rows: text.includes('<=>') ? vector : keyword }),
  } as unknown as Pool;
}

describe('retrieval thresholds', () => {
  it('keeps an on-topic vector match and drops one below the minimum similarity', async () => {
    const pool = postgresDouble(
      [
        searchRow('on-topic', { similarity: MIN_VECTOR_SIMILARITY + 0.2 }),
        searchRow('off-topic', { similarity: MIN_VECTOR_SIMILARITY - 0.2 }),
      ],
      [],
    );

    expect(await retrieveFromPostgres(pool, 'ws-a', [0.1], 'kopi prices?', 8)).toEqual([
      chunk('on-topic'),
    ]);
  });

  it('returns nothing when no vector match clears the threshold and no keyword chunk matches', async () => {
    const pool = postgresDouble([searchRow('off-topic', { distance: 1 - (MIN_VECTOR_SIMILARITY - 0.2) })], []);

    expect(await retrieveFromPostgres(pool, 'ws-a', [0.1], 'what is for lunch?', 8)).toEqual([]);
  });
});
