import { createHash } from 'node:crypto';
import { FEATURE } from '../../public/shared/features.js';
import type { UserRole, UserStatus } from '../store/users.ts';

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
export type Feature = (typeof FEATURE)[keyof typeof FEATURE];
export const FEATURES: Feature[] = Object.values(FEATURE);

/** What a signed-in user may personalise (access.customize). Model choice is the model-picker feature's. */
export const CUSTOMIZABLE = ['theme', 'instructions'];

export const ROLES: UserRole[] = ['admin', 'user'];
export const STATUSES: UserStatus[] = ['pending', 'approved', 'disabled'];

export interface RoleSpec { features?: Feature[] | '*'; models?: string[] | '*' }
/** An admin decision about one user, kept in access.users. */
export interface UserPin { role?: UserRole; status?: UserStatus }

/** The `access` block as declared in the files. */
export interface AccessConfig {
  bootstrapAdmins?: string[];
  newUsers?: 'approved' | 'pending';
  customize?: string[];
  roles?: Partial<Record<UserRole, RoleSpec>>;
  users?: Record<string, UserPin>;
}

/** The part of the config this module reads. */
export interface PolicyConfig { authMode: string; access?: AccessConfig }

// Tier 3's out-of-the-box split: users work, admins run the place.
const DEFAULT_ROLES: Record<UserRole, RoleSpec> = {
  user: { features: [FEATURE.CHAT, FEATURE.ATTACHMENTS, FEATURE.IMAGES, FEATURE.SEARCH, FEATURE.FOLDERS, FEATURE.AUTOMATIONS, FEATURE.STATISTICS, FEATURE.MODEL_PICKER], models: '*' },
  admin: { features: '*', models: '*' }
};

/**
 * Keys that can never be written through the UI or API, whatever the lock
 * state: the trust boundary, credentials, and the policy itself. They can
 * still be set in either file.
 */
export const FILE_ONLY = new Set([
  'authMode', 'authPassword', 'sessionSecret', 'sessionTtlDays', 'trustedProxyCidrs', 'trustedUserIdHeader',
  'trustedEmailHeader', 'trustedNameHeader', 'trustedRoleHeader',
  'logoutUrl', 'dbPath', 'access', 'allowedOrigins', 'allowedHosts', 'frozen', 'autoMigrate', 'retrieval',
  'googleClientId', 'googleClientSecret', 'googleRedirectUri', 'adminEmails'
]);

/**
 * Writable, but where credentials and routing live: in a multi-user
 * deployment only an admin may send these, whatever features a role has.
 */
export const SECRET_PATCH_KEYS = new Set(['baseUrl', 'apiKey', 'models', 'connectors']);

// Never logged, never fingerprinted as values, never sent to a browser.
export const SECRET_KEYS = new Set(['apiKey', 'authPassword', 'sessionSecret', 'googleClientSecret']);

/**
 * Merges the file's and the code's `access` blocks. Code wins per field;
 * `users` merges per user, code winning, so admin write-back to the file can
 * never override a user pinned in code.
 */
export function mergeAccess(fileAccess: unknown = {}, codeAccess: unknown = {}): AccessConfig {
  const f: AccessConfig = fileAccess && typeof fileAccess === 'object' ? fileAccess : {};
  const c: AccessConfig = codeAccess && typeof codeAccess === 'object' ? codeAccess : {};
  return {
    ...f, ...c,
    users: { ...(f.users || {}), ...(c.users || {}) }
  };
}

/** The effective policy, with defaults filled in, for a loaded config. */
export function resolveAccess(cfg: PolicyConfig) {
  const a = cfg.access || {};
  const roles = {} as Record<UserRole, RoleSpec>;
  for (const r of ROLES) roles[r] = { ...DEFAULT_ROLES[r], ...(a.roles?.[r] || {}) };
  return {
    bootstrapAdmins: Array.isArray(a.bootstrapAdmins) ? a.bootstrapAdmins.map(String) : [],
    newUsers: a.newUsers || 'approved' as const,
    customize: Array.isArray(a.customize) ? a.customize : ['theme'],
    roles,
    users: a.users && typeof a.users === 'object' ? a.users : {}
  };
}

const expand = (list: Feature[] | '*' | undefined) => new Set<string>(list === '*' ? FEATURES : list || []);

/**
 * What a signed-in person may use. Tiers 1 and 2 are one person, who gets
 * everything that makes sense for one person: no user management.
 */
export function featuresFor(cfg: PolicyConfig, role: UserRole | null | undefined): Set<string> {
  if (!['multiuser', 'trusted-header'].includes(cfg.authMode)) {
    const all = new Set<string>(FEATURES);
    all.delete('admin'); all.delete('oversight');
    return all;
  }
  return expand(role ? resolveAccess(cfg).roles[role]?.features : undefined);
}

/** '*' or the list of model ids this role may pick. */
export function modelsFor(cfg: PolicyConfig, role: UserRole | null | undefined): string[] | '*' {
  if (!['multiuser', 'trusted-header'].includes(cfg.authMode)) return '*';
  const m = role ? resolveAccess(cfg).roles[role]?.models : undefined;
  return m === '*' || m === undefined ? '*' : m.map(String);
}

export const MIN_PASSWORD_LENGTH = 10;

/** Every problem with a config, as readable strings. Empty means valid. */
// Takes the config as read, before anything about it is known to hold.
export function validateConfig(cfg: Record<string, any>, { env = process.env } = {}): string[] {
  const errors: string[] = [];
  const mode = cfg.authMode;
  if (mode === 'trusted-header' && !(Array.isArray(cfg.trustedProxyCidrs) && cfg.trustedProxyCidrs.length)) {
    errors.push("authMode 'trusted-header' requires trustedProxyCidrs: identity headers are only believed from those peers");
  }
  if (mode === 'single') errors.push("legacy authMode 'single' is no longer supported; choose multiuser for accounts or explicitly choose local without login");
  if (mode === 'local' && cfg.authPassword) errors.push("authMode 'local' cannot use authPassword; remove it only if you want access without login");
  if (env.TINYWEBUI_PASSWORD) errors.push('TINYWEBUI_PASSWORD no longer selects password login; unset it and use multiuser setup');

  const a: Record<string, any> | undefined = cfg.access;
  if (a !== undefined) {
    if (!a || typeof a !== 'object' || Array.isArray(a)) return [...errors, 'access must be an object'];
    const known = new Set(['bootstrapAdmins', 'newUsers', 'roles', 'users', 'customize']);
    for (const k of Object.keys(a)) if (!known.has(k)) errors.push(`access.${k} is not a known setting`);
    if (a.bootstrapAdmins !== undefined && !(Array.isArray(a.bootstrapAdmins) && a.bootstrapAdmins.every((x) => typeof x === 'string' && x))) {
      errors.push('access.bootstrapAdmins must be a list of gateway user ids');
    }
    if (a.newUsers !== undefined && !['approved', 'pending'].includes(a.newUsers)) {
      errors.push("access.newUsers must be 'approved' or 'pending'");
    }
    if (a.customize !== undefined && !(Array.isArray(a.customize) && a.customize.every((c: string) => CUSTOMIZABLE.includes(c)))) {
      errors.push(`access.customize must be a list from ${CUSTOMIZABLE.join(', ')}`);
    }
    for (const [role, spec] of Object.entries<any>(a.roles || {})) {
      if (!ROLES.includes(role as UserRole)) { errors.push(`access.roles.${role}: unknown role (known: ${ROLES.join(', ')})`); continue; }
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
      if (spec.models !== undefined && spec.models !== '*' && !(Array.isArray(spec.models) && spec.models.every((m: unknown) => typeof m === 'string' && m))) {
        errors.push(`access.roles.${role}.models must be '*' or a list of model ids (catalog ids when models is set)`);
      }
    }
    for (const [id, u] of Object.entries<any>(a.users || {})) {
      if (!u || typeof u !== 'object') { errors.push(`access.users["${id}"] must be an object`); continue; }
      if (u.role !== undefined && !ROLES.includes(u.role)) errors.push(`access.users["${id}"].role must be one of ${ROLES.join(', ')}`);
      if (u.status !== undefined && !STATUSES.includes(u.status)) errors.push(`access.users["${id}"].status must be one of ${STATUSES.join(', ')}`);
    }
  }
  return errors;
}

/** Stable JSON: object keys sorted, so key order never changes a hash. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * A short hash of the effective config and MCP servers. Secrets count only
 * as present/absent (their values never enter the hash), so a fingerprint can
 * be logged and compared against a checked-in config without leaking anything.
 */
export function fingerprint(cfg: object, mcpServers: object = {}): string {
  const redacted: Record<string, any> = {};
  for (const [k, v] of Object.entries(cfg)) {
    // The session secret is operational (it is generated on first start),
    // not policy; leaving it out keeps the CLI and the server in agreement.
    if (k === 'sessionSecret') continue;
    redacted[k] = SECRET_KEYS.has(k) ? Boolean(v) : v;
  }
  if (Array.isArray(redacted.connectors)) {
    redacted.connectors = redacted.connectors.map((c: any) => (c && typeof c === 'object' ? { ...c, apiKey: Boolean(c.apiKey) } : c));
  }
  return createHash('sha256').update(canonical({ config: redacted, mcpServers })).digest('hex').slice(0, 16);
}

/** 'file-only' | 'frozen' | 'editable' -- how a key may be changed. */
export function keyClass(key: string, lockedKeys: Set<string>): 'file-only' | 'frozen' | 'editable' {
  if (FILE_ONLY.has(key)) return 'file-only';
  if (lockedKeys.has(key)) return 'frozen';
  return 'editable';
}
