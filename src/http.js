import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

export function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

/** An error that carries its own HTTP status to the handler's catch. */
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Body caps. Most requests are a few KB; uploads and turns with images carry
// base64 (4/3 of the file), so they get room for their own per-file limits.
export const BODY_LIMIT = 1024 * 1024;
export const UPLOAD_LIMIT = 8 * 1024 * 1024;       // one 5 MB file, base64
export const TURN_LIMIT = 60 * 1024 * 1024;        // up to 8 images of 5 MB, base64

/** Reads a JSON body, refusing more than `limit` bytes (413) or bad JSON (400). */
export async function readJson(req, limit = BODY_LIMIT) {
  const declared = Number(req.headers['content-length']);
  if (declared > limit) throw new HttpError(413, `request body exceeds ${limit} bytes`);
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, `request body exceeds ${limit} bytes`);
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'request body is not valid JSON');
  }
}

// Sent on every response. The page loads only its own scripts; the one
// outside origin is the Fall Fairy theme's Google Fonts.
export const SECURITY_HEADERS = {
  'content-security-policy': [
    "default-src 'self'", "script-src 'self'", "connect-src 'self'",
    "style-src 'self' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob:", "object-src 'none'", "base-uri 'none'",
    "frame-ancestors 'none'", "form-action 'self'"
  ].join('; '),
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin'
};

/**
 * Cross-site request forgery guard for anything that changes state. Browsers
 * send Origin on cross-origin POSTs (and Sec-Fetch-Site on all modern ones),
 * so a page elsewhere cannot drive this one with the user's cookies, the
 * gateway's included -- or poke a tier-1 instance on localhost.
 */
export function crossSite(req, cfg) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return false;
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    let host;
    try { host = new URL(origin).host; } catch { return true; }
    if (host === req.headers.host) return false;
    return !(cfg.allowedOrigins || []).includes(origin);
  }
  if (origin === 'null') return true;
  return req.headers['sec-fetch-site'] === 'cross-site';
}

/**
 * DNS-rebinding guard. With no login, a hostile site can point its own name at
 * 127.0.0.1 and pass the same-origin check above (Origin and Host both name it),
 * so a no-login install only answers to loopback names and allowedHosts.
 * Logged-in modes are safe: the attacker's origin has no session cookie.
 */
export function badHost(req, cfg) {
  if (cfg.authMode !== 'none') return false;
  let hostname;
  try { hostname = new URL(`http://${req.headers.host}`).hostname.toLowerCase(); } catch { return true; }
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '127.0.0.1' || hostname === '[::1]') return false;
  return !(cfg.allowedHosts || []).some((h) => h.toLowerCase() === hostname);
}

export async function serveStatic(req, res) {
  // Resolve the index BEFORE normalising: on Windows normalize('/') returns a
  // lone backslash, so a check for '/' after it never matches and the root
  // request lands on the directory itself.
  const pathname = req.url.split('?')[0];
  const rel = normalize(pathname === '/' ? 'index.html' : pathname)
    .replace(/^(\.\.[/\\])+/, '');
  const file = join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'forbidden' });
  try {
    const data = await readFile(file);
    const ext = file.slice(file.lastIndexOf('.'));
    res.writeHead(200, { 'content-type': TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}
