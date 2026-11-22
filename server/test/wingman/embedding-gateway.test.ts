import { afterEach, describe, expect, it, vi } from 'vitest';
import { embedTexts, type GatewayConfig } from '../../src/wingman/knowledge/gateway.js';

const config: GatewayConfig = {
  baseUrl: 'http://gateway.test',
  apiKey: 'k',
  chatModel: 'chat',
  embedModel: 'qwen3-embedding',
};

afterEach(() => vi.unstubAllGlobals());

describe('embedTexts', () => {
  it('asks the gateway for 1024-dimension vectors', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ index: 0, embedding: new Array(1024).fill(0.1) }] })),
    );
    vi.stubGlobal('fetch', fetchMock);
    const vectors = await embedTexts(config, ['hello']);
    expect(vectors[0]).toHaveLength(1024);
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).toMatchObject({ model: 'qwen3-embedding', dimensions: 1024 });
  });

  it('fails loudly when the gateway returns another size', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ index: 0, embedding: new Array(2560).fill(0.1) }] })),
    ));
    await expect(embedTexts(config, ['hello'])).rejects.toThrow(/1024-dimension/);
  });
});
