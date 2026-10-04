/**
 * The page's one way to call the JSON API. A non-2xx reply throws an Error
 * carrying the server's `error` text (or the bare status), plus `.status` for
 * the few callers that treat a particular code as fine.
 *
 * Streaming endpoints (/api/chat, /api/chats/:id/stream) are read as streams
 * and still use fetch directly.
 */

async function request(method, url, body, { signal } = {}) {
  const init = { method, signal };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(out.error || String(res.status)), { status: res.status });
  return out;
}

export const api = {
  get: (url, opts) => request('GET', url, undefined, opts),
  post: (url, body, opts) => request('POST', url, body, opts),
  patch: (url, body, opts) => request('PATCH', url, body, opts),
  del: (url, opts) => request('DELETE', url, undefined, opts)
};
