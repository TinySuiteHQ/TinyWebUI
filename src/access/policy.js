import { createHash } from 'node:crypto';
import { FEATURE } from '../../public/shared/features.js';

/**
 * Access policy: who can use which parts of TinyWebUI, declared in files.
 *
 * The `access` block lives in tinywebui.config.js and/or config.json:
 *
 *   access: {
 *     bootstrapAdmins: ['<gateway user id>'],   // always admin, always approved
 *     newUsers: 'approved' | 'pending',
 *     roles: { user: { features: [...], models: [...] | '*' }, admin: { features: '*' } },
 *     users: { '<gateway user id>': { role?, status? } }  // admin decisions, written back
 *   }
 *
 * Everything here is pure: no I/O, so the server, the reload path and the CLI
 * all validate and resolve the same way.
 */

/** Every feature a role can be granted. Each maps to UI and API routes. */
export const FEATURES = Object.values(FEATURE);

export const ROLES = ['admin', 'user'];
export const STATUSES = ['pending', 'approved', 'disabled'];

// Tier 3's out-of-the-box split: users work, admins run the place.
const DEFAULT_ROLES = {
  user: { features: [FEATURE.CHAT, FEATURE.ATTACHMENTS, FEATURE.IMAGES, FEATURE.SEARCH, FEATURE.FOLDERS, FEATURE.AUTOMATIONS, FEATURE.STATISTICS, FEATURE.MODEL_PICKER], models: '*' },
  admin: { features: '*', models: '*' }
};

/**
 * Keys that can never be written through the UI or API, whatever the lock
 * state: the trust boundary, credentials, and the policy itself. They can
 * still be set in either file (so `set-password` can write config.json).
 */
export const FILE_ONLY = new Set([
  'authMode', 'authPassword', 'sessionSecret', 'sessionTtlDays', 'trustedProxyCidrs', 'trustedUserIdHeader',
  'trustedEmailHeader', 'trustedNameHeader', 'trustedRoleHeader', 'trustedDefaultStatus',
  'logoutUrl', 'baseUrl', 'apiKey', 'dbPath', 'access', 'models', 'allowedOrigins', 'frozen', 'autoMigrate', 'retrieval',
  'googleClientId', 'googleClientSecret', 'googleRedirectUri', 'adminEmails'
]);

// Never logged, never fingerprinted as values, never sent to a browser.
export const SECRET_KEYS = new Set(['apiKey', 'authPassword', 'sessionSecret', 'googleClientSecret']);

/**
 * Merges the file's and the code's `access` blocks. Code wins per field;
 * `users` merges per user, code winning, so admin write-back to the file can
 * never override a user pinned in code.
 */
export function mergeAccess(fileAccess = {}, codeAccess = {}) {
  const f = fileAccess && typeof fileAccess === 'object' ? fileAccess : {};
  const c = codeAccess && typeof codeAccess === 'object' ? codeAccess : {};
  return {
    ...f, ...c,
    users: { ...(f.users || {}), ...(c.users || {}) }
  };
}

/** The effective policy, with defaults filled in, for a loaded config. */
export function resolveAccess(cfg) {
  const a = cfg.access || {};
  const roles = {};
  for (const r of ROLES) roles[r] = { ...DEFAULT_ROLES[r], ...(a.roles?.[r] || {}) };
  return {
    bootstrapAdmins: Array.isArray(a.bootstrapAdmins) ? a.bootstrapAdmins.map(String) : [],
    newUsers: a.newUsers || (cfg.trustedDefaultStatus === 'pending' ? 'pending' : 'approved'),
    roles,
    users: a.users && typeof a.users === 'object' ? a.users : {}
  };
}

const expand = (list) => new Set(list === '*' ? FEATURES : list || []);

/**
 * What a signed-in person may use. Tiers 1 and 2 are one person, who gets
 * everything that makes sense for one person: no user management.
 */
export function featuresFor(cfg, role) {
  if (cfg.authMode !== 'trusted-header') {
    const all = new Set(FEATURES);
    all.delete('admin'); all.delete('oversight');
    return all;
  }
  return expand(resolveAccess(cfg).roles[role]?.features);
}

/** '*' or the list of model ids this role may pick. */
export function modelsFor(cfg, role) {
  if (cfg.authMode !== 'trusted-header') return '*';
  const m = resolveAccess(cfg).roles[role]?.models;
  return m === '*' || m === undefined ? '*' : m.map(String);
}

/** Every problem with a config, as readable strings. Empty means valid. */
export function validateConfig(cfg, { env = process.env } = {}) {
  const errors = [];
  const mode = cfg.authMode;
  if (mode === 'multiuser') {
    errors.push("authMode 'multiuser' has no login flow yet; use 'trusted-header' behind a gateway for Google/Apple/SSO sign-in");
  }
  if (mode === 'trusted-header' && !(Array.isArray(cfg.trustedProxyCidrs) && cfg.trustedProxyCidrs.length)) {
    errors.push("authMode 'trusted-header' requires trustedProxyCidrs: identity headers are only believed from those peers");
  }
  if (mode === 'single') {
    if (cfg.authPassword && !String(cfg.authPassword).startsWith('scrypt$')) {
      errors.push('authPassword must be a hash: run `tinywebui set-password` or set $TINYWEBUI_PASSWORD');
    } else if (!cfg.authPassword && !env.TINYWEBUI_PASSWORD) {
      errors.push("authMode 'single' needs a password: run `tinywebui set-password` or set $TINYWEBUI_PASSWORD");
    }
  }

  const a = cfg.access;
  if (a !== undefined) {
    if (!a || typeof a !== 'object' || Array.isArray(a)) return [...errors, 'access must be an object'];
    const known = new Set(['bootstrapAdmins', 'newUsers', 'roles', 'users']);
    for (const k of Object.keys(a)) if (!known.has(k)) errors.push(`access.${k} is not a known setting`);
    if (a.bootstrapAdmins !== undefined && !(Array.isArray(a.bootstrapAdmins) && a.bootstrapAdmins.every((x) => typeof x === 'string' && x))) {
      errors.push('access.bootstrapAdmins must be a list of gateway user ids');
    }
    if (a.newUsers !== undefined && !['approved', 'pending'].includes(a.newUsers)) {
      errors.push("access.newUsers must be 'approved' or 'pending'");
    }
    for (const [role, spec] of Object.entries(a.roles || {})) {
      if (!ROLES.includes(role)) { errors.push(`access.roles.${role}: unknown role (known: ${ROLES.join(', ')})`); continue; }
      if (!spec || typeof spec !== 'object') { errors.push(`access.roles.${role} must be an object`); continue; }
      for (const k of Object.keys(spec)) {
        if (!['features', 'models'].includes(k)) errors.push(`access.roles.${role}.${k} is not a known setting`);
      }
      if (spec.features !== undefined && spec.features !== '*') {
        if (!Array.isArray(spec.features)) errors.push(`access.roles.${role}.features must be '*' or a list`);
        else for (const f of spec.features) {
          if (!FEATURES.includes(f)) errors.push(`access.roles.${role}.features: unknown feature "${f}" (known: ${FEATURES.join(', ')})`);
        }
      }
      if (spec.models !== undefined && spec.models !== '*' && !(Array.isArray(spec.models) && spec.models.every((m) => typeof m === 'string' && m))) {
        errors.push(`access.roles.${role}.models must be '*' or a list of model ids (catalog ids when models is set)`);
      }
    }
    for (const [id, u] of Object.entries(a.users || {})) {
      if (!u || typeof u !== 'object') { errors.push(`access.users["${id}"] must be an object`); continue; }
      if (u.role !== undefined && !ROLES.includes(u.role)) errors.push(`access.users["${id}"].role must be one of ${ROLES.join(', ')}`);
      if (u.status !== undefined && !STATUSES.includes(u.status)) errors.push(`access.users["${id}"].status must be one of ${STATUSES.join(', ')}`);
    }
  }
  return errors;
}

/** Stable JSON: object keys sorted, so key order never changes a hash. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * A short hash of the effective config and MCP servers. Secrets count only
 * as present/absent (their values never enter the hash), so a fingerprint can
 * be logged and compared against a checked-in config without leaking anything.
 */
export function fingerprint(cfg, mcpServers = {}) {
  const redacted = {};
  for (const [k, v] of Object.entries(cfg)) {
    // The session secret is operational (it is generated on first start),
    // not policy; leaving it out keeps the CLI and the server in agreement.
    if (k === 'sessionSecret') continue;
    redacted[k] = SECRET_KEYS.has(k) ? Boolean(v) : v;
  }
  return createHash('sha256').update(canonical({ config: redacted, mcpServers })).digest('hex').slice(0, 16);
}

/** 'file-only' | 'frozen' | 'editable' -- how a key may be changed. */
export function keyClass(key, lockedKeys) {
  if (FILE_ONLY.has(key)) return 'file-only';
  if (lockedKeys.has(key)) return 'frozen';
  return 'editable';
}
