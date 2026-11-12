/**
 * The page's one way to call the JSON API. A non-2xx reply throws an Error
 * carrying the server's `error` text (or the bare status), plus `.status` for
 * the few callers that treat a particular code as fine.
 *
 * Streaming endpoints (/api/chat, /api/chats/:id/stream) are read as streams
 * and use fetch directly (core/sse.ts reads them). `blob` is for the few
 * binary reads (a stored image put back on the composer), `download` for
 * the exports that are saved as files.
 */

export type ApiError = Error & { status?: number };
// A reply whose shape is in shared/api.ts is asked for by name (api.get<ToolsReply>(...));
// the areas not moved there yet still read loose JSON.
type Json = any;

async function request<T>(method: string, url: string, body?: unknown, { signal }: { signal?: AbortSignal } = {}): Promise<T> {
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
  get: <T = Json>(url: string, opts?: Opts) => request<T>('GET', url, undefined, opts),
  post: <T = Json>(url: string, body?: unknown, opts?: Opts) => request<T>('POST', url, body, opts),
  patch: <T = Json>(url: string, body?: unknown, opts?: Opts) => request<T>('PATCH', url, body, opts),
  del: <T = Json>(url: string, opts?: Opts) => request<T>('DELETE', url, undefined, opts),
  async blob(url: string, opts?: Opts): Promise<Blob> {
    const res = await fetch(url, { signal: opts?.signal });
    if (!res.ok) {
      const out = await res.json().catch(() => ({}));
      throw Object.assign(new Error(out.error || String(res.status)), { status: res.status });
    }
    return res.blob();
  },
  /**
   * Saves what a GET answers as a file, under the name the server gives it.
   * Fetched rather than linked so a refusal shows as an error here instead of
   * downloading the error's JSON.
   */
  async download(url: string, fallbackName: string): Promise<void> {
    const res = await fetch(url);
    if (!res.ok) {
      const out = await res.json().catch(() => ({}));
      throw Object.assign(new Error(out.error || String(res.status)), { status: res.status });
    }
    const disposition = res.headers.get('content-disposition') || '';
    const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
    const name = star ? decodeURIComponent(star[1] as string) : fallbackName;
    const href = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement('a'), { href, download: name });
    a.click();
    // Revoked a moment later: some browsers start the save after click() returns.
    setTimeout(() => URL.revokeObjectURL(href), 10000);
  }
};
