import { randomBytes, createHmac, createHash, timingSafeEqual, scryptSync } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { resolveAccess } from './policy.js';

/**
 * Session/cookie plumbing for authMode 'single' (password login), plus the
 * identity resolution for 'trusted-header' further down.
 * No framework, no dependency: a signed HTTP-only cookie names a session
 * token, and the token itself is looked up (by its hash, never the raw
 * value) against the `sessions` table. When authMode is 'none' none of this
 * is ever called -- see auth_gate.js.
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
  store.addSession(sha256(token), userId, Date.now() + ttlDays * 86400_000);
  return token;
}

export function destroySession(store, token) {
  store.deleteSession(sha256(token));
}

export function destroyUserSessions(store, userId) {
  store.deleteUserSessions(userId);
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

/* ---------- password (authMode 'single') ---------- */

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** `scrypt$<salt hex>$<hash hex>` -- what authPassword holds. Never plaintext. */
export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(password), salt, 32, SCRYPT);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [kind, saltHex, hashHex] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(String(password ?? ''), Buffer.from(saltHex, 'hex'), expected.length, SCRYPT);
  return timingSafeEqual(actual, expected);
}

/** The raw session token from a validly signed cookie, or null. */
export function sessionToken(req, cfg) {
  const raw = readCookie(req);
  if (!raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot === -1) return null;
  const token = raw.slice(0, dot);
  return cfg.sessionSecret && verify(token, raw.slice(dot + 1), cfg.sessionSecret) ? token : null;
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
export function isSecureRequest(req, trustedProxyCidrs = []) {
  if (req.socket?.encrypted === true) return true;
  // X-Forwarded-Proto is a claim only a known proxy may make.
  return req.headers['x-forwarded-proto'] === 'https' && ipInCidrs(req.socket?.remoteAddress, trustedProxyCidrs);
}

/**
 * Resolves the logged-in user for a request, or null. Verifies the cookie's
 * signature first (cheap, rejects tampering/forgery), then looks up the
 * token's hash in `sessions` and checks expiry.
 */
export function getSessionUser(req, store, cfg) {
  const token = sessionToken(req, cfg);
  if (!token) return null;

  const session = store.getSession(sha256(token));
  if (!session || session.expires_at < Date.now()) return null;

  return store.getUser(session.user_id);
}

/* ---------- trusted-header mode ---------- */

/**
 * One JSON line per security-relevant event, on stdout for the deployment's
 * log collector. Never pass content, prompts, tokens or raw header values.
 */
export function audit(event, fields = {}) {
  console.log(`[tinywebui:audit] ${JSON.stringify({ ts: new Date().toISOString(), event, ...fields })}`);
}

/** Parsed once per cidr list; `::ffff:1.2.3.4` peers are checked as IPv4. */
const blockLists = new WeakMap();
export function ipInCidrs(ip, cidrs) {
  if (!ip || !Array.isArray(cidrs) || !cidrs.length) return false;
  let list = blockLists.get(cidrs);
  if (!list) {
    list = new BlockList();
    for (const cidr of cidrs) {
      const [addr, bits] = String(cidr).split('/');
      const family = isIP(addr) === 6 ? 'ipv6' : 'ipv4';
      const prefix = bits === undefined ? (family === 'ipv6' ? 128 : 32) : Number(bits);
      list.addSubnet(addr, prefix, family);
    }
    blockLists.set(cidrs, list);
  }
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return list.check(mapped[1], 'ipv4');
  return list.check(ip, isIP(ip) === 6 ? 'ipv6' : 'ipv4');
}

const HEADER_ROLES = new Set(['admin', 'user']);
const LOGIN_TOUCH_MS = 60_000;

function header(req, name) {
  const v = req.headers[String(name).toLowerCase()];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' ? s.trim() : '';
}

/**
 * Resolves (and on first sight provisions) the user an upstream gateway has
 * vouched for. Returns { user } or { reject: reason }.
 *
 * Headers are believed only from a peer inside trustedProxyCidrs, judged by
 * the socket address -- never X-Forwarded-For, which the client controls.
 * The external id is the identity; email and name are metadata that follow
 * the gateway. Role follows the gateway when it sends one; status is only
 * ever set here on creation and otherwise belongs to TinyWebUI admins.
 */
export function resolveTrustedUser(req, store, cfg) {
  if (!ipInCidrs(req.socket?.remoteAddress, cfg.trustedProxyCidrs)) return { reject: 'untrusted_peer' };
  const externalId = header(req, cfg.trustedUserIdHeader).slice(0, 256);
  if (!externalId) return { reject: 'missing_identity' };
  const email = header(req, cfg.trustedEmailHeader).slice(0, 320).toLowerCase() || null;
  const name = header(req, cfg.trustedNameHeader).slice(0, 200) || null;
  const rawRole = header(req, cfg.trustedRoleHeader).toLowerCase();
  const role = HEADER_ROLES.has(rawRole) ? rawRole : null;

  const now = Date.now();
  // Precedence: the files (bootstrapAdmins, access.users) > gateway role
  // header > defaults. What an admin decided is in access.users, so the file
  // outranks a gateway that still says otherwise.
  const policy = resolveAccess(cfg);
  const pinned = policy.bootstrapAdmins.includes(externalId)
    ? { role: 'admin', status: 'approved' }
    : policy.users[externalId] || {};
  const wantRole = pinned.role || role;
  const status = pinned.status || policy.newUsers;
  let { user, created } = store.provisionUser({ externalId, role: wantRole || 'user', status, now });
  if (created) audit('user.provisioned', { userId: user.id, role: user.role, status: user.status });

  const changes = {};
  if (email !== user.email) {
    // Emails are unique; one held by another account is dropped, never merged.
    const next = email && store.emailTaken(email, user.id) ? null : email;
    if (next !== user.email) changes.email = next;
  }
  if (name !== user.name) changes.name = name;
  if (wantRole && wantRole !== user.role) {
    changes.role = wantRole;
    audit('user.role_changed', { userId: user.id, from: user.role, to: wantRole, by: pinned.role ? 'policy' : 'gateway' });
  }
  if (pinned.status && pinned.status !== user.status) {
    changes.status = pinned.status;
    audit('user.status_changed', { userId: user.id, from: user.status, to: pinned.status, by: 'policy' });
  }
  if (!user.last_login_at || now - user.last_login_at > LOGIN_TOUCH_MS) changes.last_login_at = now;
  if (Object.keys(changes).length) user = store.syncUser(user.id, changes);
  return { user };
}

/**
 * Brings every provisioned user in line with the files' access.users and
 * bootstrapAdmins, so a status decided in a file (a ban, say) holds even for
 * someone who has not made a request since -- their automations included.
 */
export function applyAccessPolicy(store, cfg) {
  const policy = resolveAccess(cfg);
  const pins = { ...policy.users };
  for (const id of policy.bootstrapAdmins) pins[id] = { role: 'admin', status: 'approved' };
  for (const [externalId, pin] of Object.entries(pins)) {
    const user = store.userByExternalId(externalId);
    if (!user) continue;
    const role = pin.role && pin.role !== user.role ? pin.role : null;
    const status = pin.status && pin.status !== user.status ? pin.status : null;
    if (!role && !status) continue;
    store.updateUser(user.id, { ...(role ? { role } : {}), ...(status ? { status } : {}) });
    audit('user.policy_applied', { userId: user.id, ...(role ? { role } : {}), ...(status ? { status } : {}) });
  }
}
