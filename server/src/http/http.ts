import type { IncomingMessage, ServerResponse } from 'node:http';

/** A request body that parsed as JSON, or the status and error to answer with. */
export type JsonBody = { ok: true; value: unknown } | { ok: false; status: number; error: string };

/** Write one JSON response, unless the response has already ended. */
export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.writableEnded) return;
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

/** The trimmed value of one cookie, or undefined when it is absent or empty. */
export function cookieValue(request: IncomingMessage, name: string): string | undefined {
  const header = request.headers.cookie;
  if (typeof header !== 'string' || header === '') return undefined;
  for (const pair of header.split(';')) {
    const index = pair.indexOf('=');
    if (index < 0) continue;
    if (pair.slice(0, index).trim() !== name) continue;
    const value = pair.slice(index + 1).trim();
    if (value !== '') return value;
  }
  return undefined;
}

/** Read a request body as UTF-8 text, failing once it grows past `maxBytes`. */
export function readBody(request: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let overflowed = false;
    const chunks: Buffer[] = [];

    request.on('data', (chunk: Buffer) => {
      if (overflowed) return;
      size += chunk.length;
      if (size > maxBytes) {
        overflowed = true;
        reject(new Error(`Request body exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (!overflowed) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    request.on('error', reject);
  });
}

/** Read and parse a JSON request body, naming the 400 it should answer with on failure. */
export async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<JsonBody> {
  let body: string;
  try {
    body = await readBody(request, maxBytes);
  } catch (error) {
    return { ok: false, status: 400, error: error instanceof Error ? error.message : 'Could not read body' };
  }

  try {
    return { ok: true, value: JSON.parse(body) as unknown };
  } catch {
    return { ok: false, status: 400, error: 'Body must be valid JSON' };
  }
}
