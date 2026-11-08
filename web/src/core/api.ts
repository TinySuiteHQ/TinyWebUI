/**
 * The page's one way to call the JSON API. A non-2xx reply throws an Error
 * carrying the server's `error` text (or the bare status), plus `.status` for
 * the few callers that treat a particular code as fine.
 *
 * Streaming endpoints (/api/chat, /api/chats/:id/stream) are read as streams
 * and use fetch directly (core/sse.ts reads them).
 */

export type ApiError = Error & { status?: number };
// Replies are JSON whose shape each caller knows; `any` keeps those call sites readable.
type Json = any;

async function request(method: string, url: string, body?: unknown, { signal }: { signal?: AbortSignal } = {}): Promise<Json> {
  const init: RequestInit = { method, signal };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(out.error || String(res.status)), { status: res.status });
  return out;
}

type Opts = { signal?: AbortSignal };

export const api = {
  get: (url: string, opts?: Opts) => request('GET', url, undefined, opts),
  post: (url: string, body?: unknown, opts?: Opts) => request('POST', url, body, opts),
  patch: (url: string, body?: unknown, opts?: Opts) => request('PATCH', url, body, opts),
  del: (url: string, opts?: Opts) => request('DELETE', url, undefined, opts)
};
