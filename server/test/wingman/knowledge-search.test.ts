import { describe, expect, it } from 'vitest';
import {
  createSearchCompanyData,
  parseFactsResponse,
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
        retrieve: async (_embedding, limit) => {
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

    const facts = await search('How much does delivery commission cost us?', 'producer');

    expect(embedded).toBe('How much does delivery commission cost us?');
    expect(retrievedLimit).toBe(8);
    expect(requests[0]).toContain('producer');
    expect(requests[0]).toContain('Anchor butter price notice');
    expect(requests[0]).toContain('published=2026-11-10');
    expect(facts).toHaveLength(1);
    expect(facts[0]?.source).toContain('Anchor');
  });

  it('allows an empty fact list when nothing is relevant', async () => {
    const search = createSearchCompanyData(deps({ chat: async () => '{"facts":[]}' }));
    expect(await search('What is for lunch?', 'producer')).toEqual([]);
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
    expect(await search('Unknown', 'producer')).toEqual([]);
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
