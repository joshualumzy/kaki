import type { IncomingMessage, ServerResponse } from 'node:http';
import { SAMPLE_WORKSPACE } from '../workspace/sample';

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

/** A same-site path that cannot be read as a protocol-relative URL such as `//evil.example`. */
function localPath(path: string): boolean {
  if (path === '/') return true;
  if (!path.startsWith('/')) return false;
  const afterSlash = path[1];
  return afterSlash !== undefined && afterSlash !== '/' && afterSlash !== '\\';
}

/** The page a person came from on this site, or the front page. */
function backPath(request: IncomingMessage): string {
  const referer = request.headers.referer;
  const host = request.headers.host;
  if (typeof referer === 'string' && typeof host === 'string') {
    try {
      const url = new URL(referer);
      if (url.host.toLowerCase() === host.toLowerCase()) {
        const path = `${url.pathname}${url.search}`;
        if (localPath(path)) return path;
      }
    } catch {
      // A malformed Referer is not a way back.
    }
  }
  return '/';
}

/**
 * A person who clicked a Mattermost link must never land on raw JSON. This page uses the same
 * pearl-and-card look as Kaki itself, says plainly what happened, and offers the way back.
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
<title>Mattermost · Kaki</title>
<style>
  :root{color-scheme:light}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;
    font:16px/1.55 "Geist","Inter","Segoe UI",system-ui,-apple-system,sans-serif;color:#0d1117;
    background:radial-gradient(circle at 18% 12%,rgba(0,190,170,.22),transparent 46%),
      radial-gradient(circle at 86% 84%,rgba(255,90,31,.16),transparent 44%),#e9ecf2}
  .card{width:min(34rem,100%);padding:30px 32px;border-radius:22px;background:#fff;
    border:1px solid rgba(13,17,23,.09);box-shadow:0 1px 0 #fff inset,0 24px 60px -26px rgba(30,40,70,.35)}
  .brand{display:inline-flex;align-items:center;gap:8px;margin:0 0 18px;
    font:600 13px/1 "Geist Mono","JetBrains Mono",ui-monospace,Menlo,monospace;letter-spacing:.14em;
    text-transform:uppercase;color:#007f6d}
  .brand i{width:9px;height:9px;border-radius:50%;background:#00a58e;display:inline-block}
  h1{margin:0 0 10px;font-size:clamp(24px,4vw,30px);line-height:1.12;letter-spacing:-.035em;color:#0d1117}
  p{margin:0 0 12px;color:#5a6472}
  p.reason{padding:10px 14px;border-radius:12px;background:rgba(255,90,31,.1);
    border:1px solid rgba(255,90,31,.28);color:#b45309;font-weight:600;font-size:14px}
  a.back{display:inline-flex;align-items:center;justify-content:center;min-height:44px;margin-top:10px;
    padding:12px 18px;border-radius:13px;background:#0d1117;color:#e9ecf2;font-weight:700;
    text-decoration:none;box-shadow:0 14px 30px -12px rgba(13,17,23,.55)}
  a.back:hover{background:#1c2430}
  a.back:focus-visible{outline:2px solid #00a58e;outline-offset:3px}
</style>
</head><body><main class="card">
  <p class="brand"><i></i>Kaki</p>
  <h1>This tool can't be opened here</h1>
  <p class="reason">${reason}</p>
  <p>Mattermost is set up in the ${escapeHtml(SAMPLE_WORKSPACE.name)} workspace. Open that workspace to try the connected tools.</p>
  <a class="back" href="${back}">Back to the workspace</a>
</main></body></html>`,
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
