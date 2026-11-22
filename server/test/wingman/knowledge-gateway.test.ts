import { afterEach, describe, expect, it, vi } from 'vitest';
import { embedTexts, gatewayConfigFromEnv } from '../../src/wingman/knowledge/gateway';

const baseEnv = { KAKI_LLM_BASE_URL: 'http://gateway.test/v1', KAKI_LLM_API_KEY: 'k' };

function mockEmbeddings(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { input: string[] };
    return new Response(
      JSON.stringify({ data: body.input.map((_, index) => ({ index, embedding: new Array(1024).fill(0.1) })) }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('embedding size setting', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends no dimensions when KAKI_EMBED_DIMENSIONS is unset', async () => {
    const fetchMock = mockEmbeddings();
    await embedTexts(gatewayConfigFromEnv(baseEnv), ['hello']);
    const sent = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(sent).not.toHaveProperty('dimensions');
  });

  it('asks the model for 1024 dimensions when KAKI_EMBED_DIMENSIONS=1024', async () => {
    const fetchMock = mockEmbeddings();
    const config = gatewayConfigFromEnv({ ...baseEnv, KAKI_EMBED_MODEL: 'qwen3-embedding', KAKI_EMBED_DIMENSIONS: '1024' });
    await embedTexts(config, ['hello']);
    const sent = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(sent).toMatchObject({ model: 'qwen3-embedding', dimensions: 1024 });
  });

  it('refuses any size other than the stored 1024', () => {
    expect(() => gatewayConfigFromEnv({ ...baseEnv, KAKI_EMBED_DIMENSIONS: '2560' })).toThrow(/must be 1024/);
  });
});
