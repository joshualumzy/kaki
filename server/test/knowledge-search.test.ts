import { describe, expect, it } from 'vitest';
import {
  createSearchCompanyData,
  parseFactsResponse,
  type RetrievedChunk,
  type SearchDeps,
} from '../src/wingman/knowledge/search';

const chunks: RetrievedChunk[] = [
  {
    source: 'mail',
    ref: '<starfruit-build-date@example>',
    text: '[Mail: Final build date moved up, 16 Nov 2026]\n\nDeliver by 17 November 2026.',
    publishedAt: '2026-11-16',
  },
  {
    source: 'wiki',
    ref: 'hawker-heroes/publisher-contract#2-milestones',
    text: '[Wiki: Starfruit Publishing - Contract Summary, updated 10 Nov 2026]\n\nFinal build 20 November 2026.',
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
            text: 'The Starfruit email (16 Nov) says the 17th; the wiki contract summary (10 Nov) still says the 20th. The newer email wins.',
            source: 'Starfruit email and wiki contract summary',
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
                text: 'Starfruit email (16 Nov) says the 17th; the wiki contract summary (10 Nov) still says the 20th. The newer email wins.',
                source: 'Starfruit email; wiki contract summary',
                date: '2026-11-16',
              },
            ],
          });
        },
      }),
    );

    const facts = await search('When does Starfruit need the final build?', 'producer');

    expect(embedded).toBe('When does Starfruit need the final build?');
    expect(retrievedLimit).toBe(8);
    expect(requests[0]).toContain('producer');
    expect(requests[0]).toContain('Final build date moved up');
    expect(requests[0]).toContain('published=2026-11-10');
    expect(facts).toHaveLength(1);
    expect(facts[0]?.source).toContain('Starfruit');
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
    expect(() => parseFactsResponse('{"facts":[{"text":"x","source":"","date":"2026-11-10"}]}')).toThrow(
      /source must be a non-empty string/,
    );
    expect(() =>
      parseFactsResponse(
        JSON.stringify({
          facts: [1, 2, 3, 4].map((index) => ({ text: `f${index}`, source: 's', date: '2026-11-10' })),
        }),
      ),
    ).toThrow(/maximum is 3/);
  });
});
