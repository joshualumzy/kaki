import type { IncomingMessage, ServerResponse } from 'node:http';

/** A request body that parsed as JSON, or the status and error to answer with. */
export type JsonBody = { ok: true; value: unknown } | { ok: false; status: number; error: string };

/** Write one JSON response, unless the response has already ended. */
export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.writableEnded) return;
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

/** Write one HTML response, unless the response has already ended. */
export function sendHtml(response: ServerResponse, status: number, body: string): void {
  if (response.writableEnded) return;
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(body);
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** The page a person came from on this site, or the front page. */
function backPath(request: IncomingMessage): string {
  const referer = request.headers.referer;
  const host = request.headers.host;
  if (typeof referer === 'string' && typeof host === 'string') {
    try {
      const url = new URL(referer);
      if (url.host.toLowerCase() === host.toLowerCase()) return `${url.pathname}${url.search}`;
    } catch {
      // A malformed Referer is not a way back.
    }
  }
  return '/';
}

/**
 * A person who clicked a Mattermost link must never land on raw JSON. This plain page says what
 * happened and offers the way back to the meeting they came from.
 */
export function sendMattermostRefusal(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  message: string,
): void {
  const back = escapeHtml(backPath(request));
  const reason = escapeHtml(message);
  sendHtml(
    response,
    status,
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kaki could not open Mattermost</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1.25rem;color:#1b1b1f;background:#fff}
h1{font-size:1.35rem;margin:0 0 .5rem}p{margin:.5rem 0 1.25rem}.back{display:inline-block;padding:.6rem 1rem;border-radius:10px;background:#2457d6;color:#fff;text-decoration:none}</style>
</head><body><h1>Kaki could not open Mattermost</h1><p>${reason}</p><a class="back" href="${back}">Back to Kaki</a></body></html>`,
  );
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
