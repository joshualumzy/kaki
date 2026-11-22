import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { cookieValue, readBody, readJsonBody, sendJson } from '../../src/http/http';

function requestWith(body: string, headers: Record<string, string> = {}): IncomingMessage {
  const stream = Readable.from(body === '' ? [] : [Buffer.from(body)]) as unknown as IncomingMessage;
  stream.headers = headers;
  return stream;
}

function fakeResponse(): {
  response: ServerResponse;
  status(): number | undefined;
  body(): string;
  ended(): boolean;
} {
  let status: number | undefined;
  let body = '';
  let ended = false;
  const response = {
    get writableEnded() {
      return ended;
    },
    writeHead(value: number) {
      status = value;
      return response;
    },
    end(chunk: string) {
      body = chunk;
      ended = true;
    },
  } as unknown as ServerResponse;
  return { response, status: () => status, body: () => body, ended: () => ended };
}

describe('sendJson', () => {
  it('writes the status and JSON body once', () => {
    const target = fakeResponse();
    sendJson(target.response, 201, { ok: true });
    expect(target.status()).toBe(201);
    expect(target.body()).toBe('{"ok":true}');
    expect(target.ended()).toBe(true);
  });

  it('does nothing when the response has already ended', () => {
    const target = fakeResponse();
    target.response.end('');
    sendJson(target.response, 500, { error: 'late' });
    expect(target.status()).toBeUndefined();
    expect(target.body()).toBe('');
  });
});

describe('cookieValue', () => {
  it('reads a trimmed value from the cookie header', () => {
    const request = requestWith('', { cookie: 'other=1; token=abc ; last=2' });
    expect(cookieValue(request, 'token')).toBe('abc');
  });

  it('skips empty values and returns undefined when absent', () => {
    expect(cookieValue(requestWith('', { cookie: 'token= ' }), 'token')).toBeUndefined();
    expect(cookieValue(requestWith('', { cookie: 'other=1' }), 'token')).toBeUndefined();
    expect(cookieValue(requestWith('', {}), 'token')).toBeUndefined();
  });
});

describe('readBody', () => {
  it('reads the body as UTF-8 text', async () => {
    await expect(readBody(requestWith('hello'), 100)).resolves.toBe('hello');
  });

  it('rejects a body that grows past the limit', async () => {
    await expect(readBody(requestWith('too long'), 4)).rejects.toThrow('Request body exceeds 4 bytes');
  });
});

describe('readJsonBody', () => {
  it('parses a JSON body', async () => {
    await expect(readJsonBody(requestWith('{"a":1}'), 100)).resolves.toEqual({ ok: true, value: { a: 1 } });
  });

  it('names the 400 for invalid JSON', async () => {
    await expect(readJsonBody(requestWith('not json'), 100)).resolves.toEqual({
      ok: false,
      status: 400,
      error: 'Body must be valid JSON',
    });
  });

  it('names the 400 and the limit when the body is too large', async () => {
    await expect(readJsonBody(requestWith('12345'), 4)).resolves.toEqual({
      ok: false,
      status: 400,
      error: 'Request body exceeds 4 bytes',
    });
  });
});
