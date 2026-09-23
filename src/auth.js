import { randomBytes, createHmac, createHash, timingSafeEqual } from 'node:crypto';

/**
 * Session/cookie plumbing for the optional auth modes ('single'/'multiuser').
 * No framework, no dependency: a signed HTTP-only cookie names a session
 * token, and the token itself is looked up (by its hash, never the raw
 * value) against the `sessions` table. When authMode is 'none' none of this
 * is ever called -- see withAuth() in server.js.
 */

const COOKIE_NAME = 'tinywebui_session';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** HMAC-signs a value so a client can hold it without being able to forge it. */
function sign(value, secret) {
  return createHmac('sha256', secret).update(value).digest('hex');
}

function verify(value, sig, secret) {
  const expected = sign(value, secret);
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createSession(store, userId, ttlDays = 30) {
  const token = randomBytes(32).toString('hex');
  const now = Date.now();
  store.db.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).run(sha256(token), userId, now, now + ttlDays * 86400_000);
  return token;
}

export function destroySession(store, token) {
  store.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function destroyUserSessions(store, userId) {
  store.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

/** Builds the Set-Cookie header value for a freshly created session token. */
export function sessionCookie(token, secret, { secure = false } = {}) {
  const signature = sign(token, secret);
  const parts = [
    `${COOKIE_NAME}=${token}.${signature}`,
    'Path=/', 'HttpOnly', 'SameSite=Lax',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearCookie({ secure = false } = {}) {
  const parts = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function readCookie(req) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    if (name === COOKIE_NAME) return part.slice(idx + 1).trim();
  }
  return null;
}

/** Whether the connection looks TLS-terminated, for the cookie's Secure flag. */
export function isSecureRequest(req) {
  return req.headers['x-forwarded-proto'] === 'https' || req.socket?.encrypted === true;
}

/**
 * Resolves the logged-in user for a request, or null. Verifies the cookie's
 * signature first (cheap, rejects tampering/forgery), then looks up the
 * token's hash in `sessions` and checks expiry.
 */
export function getSessionUser(req, store, cfg) {
  const raw = readCookie(req);
  if (!raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot === -1) return null;
  const token = raw.slice(0, dot);
  const signature = raw.slice(dot + 1);
  if (!cfg.sessionSecret || !verify(token, signature, cfg.sessionSecret)) return null;

  const session = store.db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(sha256(token));
  if (!session || session.expires_at < Date.now()) return null;

  return store.db.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id) || null;
}
