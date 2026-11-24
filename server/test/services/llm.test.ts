import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeLlm, createOpenAiLlm, LlmError, llmFromEnv, notetakerLlmFromEnv, parseJsonReply, serverSentData } from '../../src/services/llm';

afterEach(() => vi.useRealTimers());

function replyWith(body: unknown, status = 200): typeof fetch {
  return async () => new Response(JSON.stringify(body), { status });
}

describe('OpenAI-compatible LLM client', () => {
  it('sends an output token ceiling and returns API usage for paid playtests', async () => {
    let request: Record<string, unknown> = {};
    const llm = createOpenAiLlm({
      baseUrl: 'https://gateway.example/v1', apiKey: 'secret', model: 'chat',
      fetchImpl: async (_url, init) => {
        request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ choices: [{ message: { content: 'hello' } }], usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 } }));
      },
    });
    expect(await llm.completeWithUsage([{ role: 'user', content: 'hi' }], { maxTokens: 96 })).toEqual({
      content: 'hello', usage: { promptTokens: 12, completionTokens: 2, totalTokens: 14 },
    });
    expect(request.max_tokens).toBe(96);
  });

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

  it('sends a strict JSON schema instead of plain JSON mode when one is given', async () => {
    let request: Record<string, unknown> = {};
    const schema = {
      name: 'reply',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: { ok: { type: 'boolean' } },
      },
    };
    const llm = createOpenAiLlm({
      baseUrl: 'https://gateway.example',
      apiKey: 'k',
      model: 'qwen',
      fetchImpl: async (_url, init) => {
        request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
      },
    });

    expect(await llm.complete([], { json: true, schema })).toBe('{"ok":true}');
    expect(request.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'reply', strict: true, schema: schema.schema },
    });
    // The schema went natively, so no schema system message is added.
    expect(request.messages).toEqual([]);
  });

  it('falls back once to plain JSON mode when the model refuses a JSON schema, then remembers it', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const schema = { name: 'reply', schema: { type: 'object' } };
    const llm = createOpenAiLlm({
      baseUrl: 'https://gateway.example',
      apiKey: 'k',
      model: 'qwen3.6:35b',
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        bodies.push(body);
        if ((body.response_format as { type?: string } | undefined)?.type === 'json_schema') {
          return new Response('{"error":"json_schema is not supported by this model"}', { status: 400 });
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }));
      },
    });

    try {
      expect(await llm.complete([], { json: true, schema })).toBe('{}');
      expect(await llm.complete([], { json: true, schema })).toBe('{}');
      expect(bodies.map((body) => (body.response_format as { type?: string } | undefined)?.type)).toEqual([
        'json_schema',
        'json_object',
        'json_object',
      ]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('qwen3.6:35b');
      expect(String(warn.mock.calls[0]?.[0])).toContain('refused a JSON schema');
    } finally {
      warn.mockRestore();
    }
  });

  it('tells the model the shape in a system message when it cannot take the schema natively', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const schema = {
      name: 'reply',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: { ok: { type: 'boolean' } },
      },
    };
    const llm = createOpenAiLlm({
      baseUrl: 'https://gateway.example',
      apiKey: 'k',
      model: 'qwen3.6:35b',
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        bodies.push(body);
        if ((body.response_format as { type?: string } | undefined)?.type === 'json_schema') {
          return new Response('{"error":"json_schema is not supported by this model"}', { status: 400 });
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
      },
    });
    const messages = [
      { role: 'system' as const, content: 'original instructions' },
      { role: 'user' as const, content: 'hi' },
    ];
    const schemaMessage = {
      role: 'system',
      content: expect.stringContaining(JSON.stringify(schema.schema)),
    };

    try {
      await llm.complete(messages, { json: true, schema });
      // (a) The retry after the refusal carries the schema system message and json_object.
      expect(bodies[1]!.response_format).toEqual({ type: 'json_object' });
      expect(bodies[1]!.messages).toEqual([...messages, schemaMessage]);
      expect((bodies[1]!.messages as Array<{ content: string }>)[2]!.content).toContain('JSON Schema');

      // (b) A later call, after the refusal, carries it too.
      await llm.complete(messages, { json: true, schema });
      expect(bodies[2]!.response_format).toEqual({ type: 'json_object' });
      expect(bodies[2]!.messages).toEqual([...messages, schemaMessage]);
    } finally {
      warn.mockRestore();
    }
  });

  it('tells the model the shape in a system message when json mode is unsupported', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const schema = { name: 'reply', schema: { type: 'object' } };
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

    try {
      expect(await llm.complete([], { json: true, schema })).toBe('{}');
      expect(bodies.at(-1)).not.toHaveProperty('response_format');
      expect(bodies.at(-1)!.messages).toEqual([
        { role: 'system', content: expect.stringContaining(JSON.stringify(schema.schema)) },
      ]);
    } finally {
      warn.mockRestore();
    }
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

describe('notetakerLlmFromEnv', () => {
  const shared = { KAKI_LLM_BASE_URL: 'https://x', KAKI_LLM_API_KEY: 'k', KAKI_LLM_MODEL: 'chat-model' };

  // The model the client puts in its request.
  async function modelUsed(env: NodeJS.ProcessEnv): Promise<unknown> {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', async (_url: unknown, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }));
    });
    try {
      await notetakerLlmFromEnv(env)!.complete([]);
    } finally {
      vi.unstubAllGlobals();
    }
    return bodies[0]!.model;
  }

  // The whole request body, for checking the reasoning switch.
  async function bodyUsed(env: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', async (_url: unknown, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }));
    });
    try {
      await notetakerLlmFromEnv(env)!.complete([], { json: true });
    } finally {
      vi.unstubAllGlobals();
    }
    return bodies[0]!;
  }

  it('uses the shared model unless a notetaker model is set', async () => {
    expect(await modelUsed(shared)).toBe('chat-model');
    expect(await modelUsed({ ...shared, KAKI_NOTETAKER_LLM_MODEL: 'notes-model' })).toBe('notes-model');
  });

  it('still needs the gateway and key, and is off without them', () => {
    expect(notetakerLlmFromEnv({})).toBeUndefined();
    expect(notetakerLlmFromEnv({ KAKI_NOTETAKER_LLM_MODEL: 'notes-model' })).toBeUndefined();
  });

  it('rejects a bad notetaker timeout', () => {
    expect(() => notetakerLlmFromEnv({ ...shared, KAKI_NOTETAKER_LLM_TIMEOUT_MS: 'soon' })).toThrow(/KAKI_LLM_TIMEOUT_MS/);
  });

  it('ignores the gateway models\' reasoning switches: its own switch, else its own model name', async () => {
    const routed = {
      ...shared,
      KAKI_LLM_BASE_URL: 'https://api.deepseek.com/v1',
      KAKI_LLM_MODEL: 'deepseek-chat',
      KAKI_LLM_FALLBACK_BASE_URL: 'https://school.example',
      KAKI_LLM_FALLBACK_API_KEY: 'k2',
      KAKI_LLM_FALLBACK_MODEL: 'fallback-model',
      KAKI_LLM_REASONING_CONTROL: 'false',
      KAKI_LLM_FALLBACK_REASONING_CONTROL: 'true',
      KAKI_NOTETAKER_LLM_MODEL: 'notes-model',
    };

    expect('reasoning_effort' in await bodyUsed(routed)).toBe(false);
    expect((await bodyUsed({ ...routed, KAKI_NOTETAKER_LLM_MODEL: 'deepseek-notes' })).reasoning_effort).toBe('none');
    expect('reasoning_effort' in await bodyUsed({ ...routed, KAKI_NOTETAKER_LLM_MODEL: 'deepseek-notes', KAKI_NOTETAKER_LLM_REASONING_CONTROL: 'false' })).toBe(false);
    expect((await bodyUsed({ ...routed, KAKI_NOTETAKER_LLM_REASONING_CONTROL: '1' })).reasoning_effort).toBe('none');
  });

  it('rejects a bad notetaker reasoning switch by name', () => {
    expect(() =>
      notetakerLlmFromEnv({ ...shared, KAKI_NOTETAKER_LLM_REASONING_CONTROL: 'sometimes' }),
    ).toThrow(/KAKI_NOTETAKER_LLM_REASONING_CONTROL/);
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

  it('falls back when the first chunk deadline fires', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', async (url: unknown, init: { signal?: AbortSignal }) => {
      if (String(url).startsWith('https://primary.example')) {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        });
      }
      return sseResponse([delta('from fallback'), 'data: [DONE]\n\n']);
    });
    try {
      const llm = llmFromEnv({
        KAKI_LLM_BASE_URL: 'https://primary.example',
        KAKI_LLM_API_KEY: 'k',
        KAKI_LLM_MODEL: 'primary-model',
        KAKI_LLM_FIRST_CHUNK_MS: '20',
        KAKI_LLM_FALLBACK_BASE_URL: 'https://fallback.example',
        KAKI_LLM_FALLBACK_API_KEY: 'k2',
        KAKI_LLM_FALLBACK_MODEL: 'fallback-model',
      })!;

      expect(await collect(llm.stream!([]))).toEqual(['from fallback']);
      expect(warn.mock.calls.map((call) => String(call[0])).some((line) => line.includes('first chunk'))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      warn.mockRestore();
    }
  });

  it('exposes the backup stream on its own so a stalled first sentence can retry with it directly', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: unknown) => {
      urls.push(String(url));
      return sseResponse([delta('from fallback'), 'data: [DONE]\n\n']);
    });
    try {
      const llm = llmFromEnv({
        KAKI_LLM_BASE_URL: 'https://primary.example',
        KAKI_LLM_API_KEY: 'k',
        KAKI_LLM_MODEL: 'primary-model',
        KAKI_LLM_FALLBACK_BASE_URL: 'https://fallback.example',
        KAKI_LLM_FALLBACK_API_KEY: 'k2',
        KAKI_LLM_FALLBACK_MODEL: 'fallback-model',
      })!;

      expect(llm.fallbackStream).toBeDefined();
      expect(await collect(llm.fallbackStream!([]))).toEqual(['from fallback']);
      expect(urls).toEqual(['https://fallback.example/chat/completions']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('ignores reasoning chunks but keeps the stream alive until the answer arrives', async () => {
    const reasoning = `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'thinking' } }] })}\n\n`;
    const llm = createOpenAiLlm({
      ...options,
      firstChunkMs: 20,
      fetchImpl: async () => sseResponse([reasoning, delta('Hi'), 'data: [DONE]\n\n']),
    });
    expect(await collect(llm.stream!([]))).toEqual(['Hi']);
  });

  it('fails loudly when a stream ends without any content', async () => {
    const llm = createOpenAiLlm({ ...options, fetchImpl: async () => sseResponse(['data: [DONE]\n\n']) });
    await expect(collect(llm.stream!([]))).rejects.toThrow(/ended without content/);
  });

  it('names a reasoning-only reply instead of accepting it as an empty answer', async () => {
    const reasoning = `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'thinking' } }] })}\n\n`;
    const llm = createOpenAiLlm({ ...options, fetchImpl: async () => sseResponse([reasoning, 'data: [DONE]\n\n']) });
    await expect(collect(llm.stream!([]))).rejects.toThrow(/reasoning only/);
  });

  it('reports an error the gateway put inside the stream instead of silently yielding nothing', async () => {
    const failure = `data: ${JSON.stringify({ error: { message: 'model is overloaded' } })}\n\n`;
    const llm = createOpenAiLlm({ ...options, fetchImpl: async () => sseResponse([failure, 'data: [DONE]\n\n']) });
    await expect(collect(llm.stream!([]))).rejects.toThrow(/model is overloaded/);
  });

  it('does not cut a slow but steady stream at the old whole-reply timeout', async () => {
    vi.useFakeTimers();
    const pieces = 6;
    const llm = createOpenAiLlm({
      ...options,
      timeoutMs: 20,
      fetchImpl: async (_url, init) => {
        const encoder = new TextEncoder();
        const signal = init?.signal;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              let sent = 0;
              const send = (): void => {
                if (signal?.aborted === true) {
                  controller.error(new DOMException('aborted', 'AbortError'));
                  return;
                }
                controller.enqueue(encoder.encode(delta(`p${sent}`)));
                sent += 1;
                if (sent === pieces) controller.close();
                else setTimeout(send, 5_000);
              };
              setTimeout(send, 5_000);
              signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
            },
          }),
        );
      },
    });

    const result = collect(llm.stream!([]));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await result).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5']);
  });

  it('reports an idle gap when the stream stalls between chunks', async () => {
    const llm = createOpenAiLlm({
      ...options,
      firstChunkMs: 1_000,
      idleMs: 20,
      fetchImpl: async (_url, init) => {
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(delta('first')));
              init?.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
            },
          }),
        );
      },
    });

    await expect(collect(llm.stream!([]))).rejects.toThrow(/stalled for 20 ms between chunks/);
  });

  it('rejects a bad first-chunk or idle deadline by name', () => {
    const base = { KAKI_LLM_BASE_URL: 'https://x', KAKI_LLM_API_KEY: 'k', KAKI_LLM_MODEL: 'm' };
    expect(() => llmFromEnv({ ...base, KAKI_LLM_FIRST_CHUNK_MS: 'soon' })).toThrow(/KAKI_LLM_FIRST_CHUNK_MS/);
    expect(() => llmFromEnv({ ...base, KAKI_LLM_IDLE_MS: '0' })).toThrow(/KAKI_LLM_IDLE_MS/);
  });
});

describe('reasoning control', () => {
  function clientFor(
    model: string,
    reasoningControl: boolean | undefined,
    bodies: Array<Record<string, unknown>>,
  ) {
    return createOpenAiLlm({
      baseUrl: 'https://gateway.example',
      apiKey: 'k',
      model,
      reasoningControl,
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }));
      },
    });
  }

  it('sends reasoning_effort exactly as DeepSeek did when control is on', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const llm = clientFor('x-test-2', true, bodies);

    await llm.complete([], { json: true });
    await llm.complete([], { json: false });
    await llm.complete([], { json: true, reasoningEffort: 'low' });

    expect(bodies.map((body) => body.reasoning_effort)).toEqual(['none', undefined, 'low']);
  });

  it('sends no reasoning_effort when control is off, even if asked', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const llm = clientFor('deepseek-chat', false, bodies);

    await llm.complete([], { json: true });
    await llm.complete([], { json: true, reasoningEffort: 'high' });

    expect(bodies.every((body) => !('reasoning_effort' in body))).toBe(true);
  });

  it('keeps the old name-based rule when control is unset', async () => {
    const deepseekBodies: Array<Record<string, unknown>> = [];
    const otherBodies: Array<Record<string, unknown>> = [];

    await clientFor('deepseek-chat', undefined, deepseekBodies).complete([], { json: true });
    await clientFor('x-test-2', undefined, otherBodies).complete([], { json: true });

    expect(deepseekBodies[0]!.reasoning_effort).toBe('none');
    expect('reasoning_effort' in otherBodies[0]!).toBe(false);
  });

  it('treats only a bounded assessment as reasoning-free in a stream when control is on', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const make = (model: string, reasoningControl: boolean) =>
      createOpenAiLlm({
        baseUrl: 'https://gateway.example',
        apiKey: 'k',
        model,
        reasoningControl,
        fetchImpl: async (_url, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return sseResponse([delta('ok'), 'data: [DONE]\n\n']);
        },
      });
    const assessment = [{ role: 'system' as const, content: '[KAKI_PROPOSAL_ASSESSMENT] rate this' }];

    await collect(make('x-test-2', true).stream!(assessment));
    await collect(make('x-test-2', false).stream!(assessment));
    await collect(make('deepseek-chat', true).stream!([{ role: 'user', content: 'hi' }]));

    expect(bodies.map((body) => body.reasoning_effort)).toEqual(['none', undefined, undefined]);
  });
});

describe('reasoning control from the environment', () => {
  const base = { KAKI_LLM_BASE_URL: 'https://school.example', KAKI_LLM_API_KEY: 'k', KAKI_LLM_MODEL: 'x-test-2' };

  async function bodyFor(env: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', async (_url: unknown, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }));
    });
    try {
      await llmFromEnv(env)!.complete([], { json: true });
    } finally {
      vi.unstubAllGlobals();
    }
    return bodies[0]!;
  }

  it('accepts true/false and 1/0 in any case, and rejects anything else', async () => {
    expect((await bodyFor({ ...base, KAKI_LLM_REASONING_CONTROL: 'TRUE' })).reasoning_effort).toBe('none');
    expect((await bodyFor({ ...base, KAKI_LLM_REASONING_CONTROL: '1' })).reasoning_effort).toBe('none');
    expect('reasoning_effort' in (await bodyFor({ ...base, KAKI_LLM_REASONING_CONTROL: 'FALSE' }))).toBe(false);
    expect('reasoning_effort' in (await bodyFor({ ...base, KAKI_LLM_REASONING_CONTROL: '0' }))).toBe(false);
    expect(() => llmFromEnv({ ...base, KAKI_LLM_REASONING_CONTROL: 'maybe' })).toThrow(/KAKI_LLM_REASONING_CONTROL/);
  });

  it('falls back to the model name when the switch is unset', async () => {
    expect((await bodyFor({ ...base, KAKI_LLM_MODEL: 'deepseek-chat' })).reasoning_effort).toBe('none');
    expect('reasoning_effort' in (await bodyFor(base))).toBe(false);
  });

  it('rejects a bad fallback switch by name', () => {
    expect(() =>
      llmFromEnv({
        ...base,
        KAKI_LLM_FALLBACK_BASE_URL: 'https://fallback.example',
        KAKI_LLM_FALLBACK_API_KEY: 'k2',
        KAKI_LLM_FALLBACK_MODEL: 'deepseek-chat',
        KAKI_LLM_FALLBACK_REASONING_CONTROL: 'sometimes',
      }),
    ).toThrow(/KAKI_LLM_FALLBACK_REASONING_CONTROL/);
  });
});

describe('fallback warnings', () => {
  const primary = {
    KAKI_LLM_BASE_URL: 'https://secret-primary.example/v1',
    KAKI_LLM_API_KEY: 'primary-key',
    KAKI_LLM_MODEL: 'primary-model',
    KAKI_LLM_REASONING_CONTROL: 'true',
  };
  const fallback = {
    KAKI_LLM_FALLBACK_BASE_URL: 'https://secret-fallback.example/v1',
    KAKI_LLM_FALLBACK_API_KEY: 'fallback-key',
    KAKI_LLM_FALLBACK_MODEL: 'fallback-model',
  };

  async function warningFor(run: () => Promise<unknown>): Promise<string[]> {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await run();
      return warn.mock.calls.map((call) => String(call[0]));
    } finally {
      vi.unstubAllGlobals();
      warn.mockRestore();
    }
  }

  function stubFetch(respond: (url: string) => Response): void {
    vi.stubGlobal('fetch', async (url: unknown) => respond(String(url)));
  }

  function expectSafeWarning(message: string): void {
    expect(message).toMatch(/^\[llm-fallback\] primary primary-model failed: .+; using fallback-model$/);
    for (const secret of ['primary-key', 'fallback-key', 'secret-primary.example', 'secret-fallback.example']) {
      expect(message).not.toContain(secret);
    }
  }

  it('warns once when complete falls back', async () => {
    stubFetch((url) =>
      url.startsWith('https://secret-primary.example')
        ? new Response('out of credits', { status: 402 })
        : new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] })),
    );

    const warnings = await warningFor(async () => {
      const llm = llmFromEnv({ ...primary, ...fallback })!;
      expect(await llm.complete([])).toBe('ok');
    });

    expect(warnings).toHaveLength(1);
    expectSafeWarning(warnings[0]!);
    expect(warnings[0]).toContain('HTTP 402');
  });

  it('falls back when the primary stream ends without content', async () => {
    stubFetch((url) =>
      url.startsWith('https://secret-primary.example')
        ? sseResponse(['data: [DONE]\n\n'])
        : sseResponse([delta('from fallback'), 'data: [DONE]\n\n']),
    );

    const warnings = await warningFor(async () => {
      const llm = llmFromEnv({ ...primary, ...fallback })!;
      expect(await collect(llm.stream!([]))).toEqual(['from fallback']);
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('ended without content');
  });

  it('warns once when stream falls back before yielding anything', async () => {
    stubFetch((url) =>
      url.startsWith('https://secret-primary.example')
        ? new Response('down', { status: 503 })
        : sseResponse([delta('from fallback'), 'data: [DONE]\n\n']),
    );

    const warnings = await warningFor(async () => {
      const llm = llmFromEnv({ ...primary, ...fallback })!;
      expect(await collect(llm.stream!([]))).toEqual(['from fallback']);
    });

    expect(warnings).toHaveLength(1);
    expectSafeWarning(warnings[0]!);
    expect(warnings[0]).toContain('HTTP 503');
  });
});
