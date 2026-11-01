import { describe, expect, it } from 'vitest';
import { createFakeLlm, createOpenAiLlm, LlmError, llmFromEnv, parseJsonReply, serverSentData } from '../src/llm';

function replyWith(body: unknown, status = 200): typeof fetch {
  return async () => new Response(JSON.stringify(body), { status });
}

describe('OpenAI-compatible LLM client', () => {
  it('posts the messages to /chat/completions and returns the reply text', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const llm = createOpenAiLlm({
      baseUrl: 'https://gateway.example/v1/',
      apiKey: 'secret',
      model: 'deepseek-chat',
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
      },
    });

    const text = await llm.complete([{ role: 'user', content: 'hi' }], { json: true });

    expect(text).toBe('{"ok":true}');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('https://gateway.example/v1/chat/completions');
    expect(new Headers(requests[0]!.init.headers).get('authorization')).toBe('Bearer secret');
    expect(JSON.parse(String(requests[0]!.init.body))).toMatchObject({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'hi' }],
      response_format: { type: 'json_object' },
    });
  });

  it('fails loudly on an HTTP error, a malformed reply, or a timeout', async () => {
    const options = { baseUrl: 'https://gateway.example', apiKey: 'k', model: 'm' };

    await expect(
      createOpenAiLlm({ ...options, fetchImpl: replyWith({ error: 'nope' }, 502) }).complete([]),
    ).rejects.toThrow(/HTTP 502/);
    await expect(createOpenAiLlm({ ...options, fetchImpl: replyWith({ choices: [] }) }).complete([])).rejects.toThrow(
      LlmError,
    );

    const hanging: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    await expect(createOpenAiLlm({ ...options, timeoutMs: 20, fetchImpl: hanging }).complete([])).rejects.toThrow(
      /timed out after 20 ms/,
    );
  });

  it('drops response_format, once and for good, when the model refuses it', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const llm = createOpenAiLlm({
      baseUrl: 'https://gateway.example',
      apiKey: 'k',
      model: 'm',
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        bodies.push(body);
        if ('response_format' in body) {
          return new Response('{"error":"response_format is not supported by this model"}', { status: 400 });
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }));
      },
    });

    expect(await llm.complete([], { json: true })).toBe('{}');
    expect(await llm.complete([], { json: true })).toBe('{}');
    expect(bodies.map((body) => 'response_format' in body)).toEqual([true, false, false]);
  });

  it('is configured from the environment only when every setting is present', () => {
    expect(llmFromEnv({})).toBeUndefined();
    expect(llmFromEnv({ KAKI_LLM_BASE_URL: 'https://x', KAKI_LLM_API_KEY: 'k' })).toBeUndefined();
    expect(llmFromEnv({ KAKI_LLM_BASE_URL: 'https://x', KAKI_LLM_API_KEY: 'k', KAKI_LLM_MODEL: 'm' })).toBeDefined();
    expect(() =>
      llmFromEnv({ KAKI_LLM_BASE_URL: 'https://x', KAKI_LLM_API_KEY: 'k', KAKI_LLM_MODEL: 'm', KAKI_LLM_TIMEOUT_MS: 'soon' }),
    ).toThrow(/KAKI_LLM_TIMEOUT_MS/);
  });
});

describe('parseJsonReply', () => {
  it('parses plain and fenced JSON', () => {
    expect(parseJsonReply('{"ok":true}')).toEqual({ ok: true });
    expect(parseJsonReply('```json\n{"ok":true}\n```')).toEqual({ ok: true });
    expect(parseJsonReply('```\n{"ok":true}\n```')).toEqual({ ok: true });
  });

  it('throws on bad JSON', () => {
    expect(() => parseJsonReply('not json')).toThrow();
  });
});

describe('fake LLM', () => {
  it('records calls and answers from the script', async () => {
    const llm = createFakeLlm((_messages, call) => `reply ${call}`);

    expect(await llm.complete([{ role: 'user', content: 'a' }])).toBe('reply 0');
    expect(await llm.complete([{ role: 'user', content: 'b' }])).toBe('reply 1');
    expect(llm.calls.map((messages) => messages[0]!.content)).toEqual(['a', 'b']);
  });
});

/** A response whose body arrives in the given pieces, as the network might deliver it. */
function sseResponse(pieces: string[], status = 200): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const piece of pieces) controller.enqueue(encoder.encode(piece));
        controller.close();
      },
    }),
    { status },
  );
}

const delta = (content: string): string => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;

async function collect(source: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const piece of source) out.push(piece);
  return out;
}

describe('serverSentData', () => {
  it('yields data payloads however the body is cut up and whichever line ending is used', async () => {
    const body = sseResponse(['da', 'ta: one\r\n\r\nda', 'ta:two\n\n: keep-alive\n\ndata: three\r', '\n\n']).body!;
    expect(await collect(serverSentData(body))).toEqual(['one', 'two', 'three']);
  });

  it('delivers a final line that has no trailing newline', async () => {
    expect(await collect(serverSentData(sseResponse(['data: last']).body!))).toEqual(['last']);
  });
});

describe('streaming', () => {
  const options = { baseUrl: 'https://gateway.example', apiKey: 'k', model: 'm' };

  it('yields the content of each chunk, stops at [DONE], and asks for a stream at the given temperature', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const llm = createOpenAiLlm({
      ...options,
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return sseResponse([delta('Hel'), delta('lo'), 'data: not json\n\n', delta(''), 'data: [DONE]\n\n', delta('ignored')]);
      },
    });
    expect(await collect(llm.stream!([{ role: 'user', content: 'hi' }], { temperature: 0.8 }))).toEqual(['Hel', 'lo']);
    expect(bodies[0]).toMatchObject({ stream: true, temperature: 0.8 });
  });

  it('reports the HTTP status and body of a failed request', async () => {
    const llm = createOpenAiLlm({ ...options, fetchImpl: async () => new Response('slow down', { status: 429 }) });
    await expect(collect(llm.stream!([]))).rejects.toThrow(/HTTP 429: slow down/);
  });

  it('ends quietly when the caller aborts mid-stream', async () => {
    const controller = new AbortController();
    const llm = createOpenAiLlm({
      ...options,
      fetchImpl: async (_url, init) => {
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream<Uint8Array>({
            start(stream) {
              stream.enqueue(encoder.encode(delta('first')));
              init?.signal?.addEventListener('abort', () => stream.error(new DOMException('aborted', 'AbortError')));
            },
          }),
        );
      },
    });
    const received: string[] = [];
    for await (const piece of llm.stream!([], { signal: controller.signal })) {
      received.push(piece);
      controller.abort();
    }
    expect(received).toEqual(['first']);
  });
});
