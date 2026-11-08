import { createHash } from 'node:crypto';
import { FEATURE } from '../../shared/features.ts';
import type { UserRole, UserStatus } from '../store/users.ts';

/**
 * Access policy: who can use which parts of TinyWebUI, declared in files.
 *
 * The `access` block lives in tinywebui.config.js and/or config.json:
 *
 *   access: {
 *     bootstrapAdmins: ['<gateway user id>'],   // always admin, always approved
 *     newUsers: 'pending' | 'approved',             // 'pending' unless the files say otherwise
 *     allowRequests: boolean,                       // multiuser: anyone may ask for an account; false unless true
 *     roles: { user: { features: [...], models: [...] | '*', customize?: [...] }, admin: { features: '*' },
 *              '<custom role>': { ... } },                 // any other name is a custom role
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

/** Always there, whatever the files say; custom roles sit beside them in access.roles. */
export const BUILTIN_ROLES: UserRole[] = ['admin', 'user'];
export const STATUSES: UserStatus[] = ['pending', 'approved', 'disabled'];
/** What a custom role may be called: a short lowercase handle, so it is safe as a key, a header value and a CLI flag. */
export const ROLE_NAME = /^[a-z][a-z0-9-]{0,31}$/;

export interface RoleSpec { features?: Feature[] | '*'; models?: string[] | '*'; customize?: string[] }
/** An admin decision about one user, kept in access.users. */
export interface UserPin { role?: UserRole; status?: UserStatus }

/** The `access` block as declared in the files. */
export interface AccessConfig {
  bootstrapAdmins?: string[];
  newUsers?: 'approved' | 'pending';
  allowRequests?: boolean;
  customize?: string[];
  roles?: Record<string, RoleSpec>;
  users?: Record<string, UserPin>;
}

/** The part of the config this module reads. */
export interface PolicyConfig { authMode: string; access?: AccessConfig }

// Tier 3's out-of-the-box split: users work, admins run the place.
const DEFAULT_ROLES: Record<string, RoleSpec> = {
  user: { features: [FEATURE.CHAT, FEATURE.ATTACHMENTS, FEATURE.IMAGES, FEATURE.SEARCH, FEATURE.FOLDERS, FEATURE.AUTOMATIONS, FEATURE.STATISTICS, FEATURE.MODEL_PICKER, FEATURE.INTEGRATIONS], models: '*' },
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
  const customize = Array.isArray(a.customize) ? a.customize : ['theme'];
  // No prototype: a role is looked up by a name from a header or the database,
  // and 'constructor' must not find Object's.
  const roles: Record<UserRole, Required<RoleSpec>> = Object.create(null);
  const declared = a.roles && typeof a.roles === 'object' ? a.roles : {};
  // A custom role starts with nothing: what it may do is what it lists.
  for (const r of new Set([...BUILTIN_ROLES, ...Object.keys(declared)])) {
    roles[r] = { features: [], models: '*', customize, ...DEFAULT_ROLES[r], ...(declared[r] || {}) };
  }
  return {
    bootstrapAdmins: Array.isArray(a.bootstrapAdmins) ? a.bootstrapAdmins.map(String) : [],
    // Someone a gateway lets through has signed in, not been let in: an admin approves them.
    newUsers: a.newUsers || 'pending' as const,
    // Off unless switched on: the addresses are unchecked, so an open form invites a queue of strangers.
    allowRequests: a.allowRequests === true,
    // The default for a role that does not say; each role's own list is in `roles`.
    customize,
    roles,
    users: a.users && typeof a.users === 'object' ? a.users : {}
  };
}

const expand = (list: Feature[] | '*' | undefined) => new Set<string>(list === '*' ? FEATURES : list || []);

/** Every role a user can hold here: the built-ins, then the custom ones in the order they were declared. */
export const roleNames = (cfg: PolicyConfig): UserRole[] => Object.keys(resolveAccess(cfg).roles);

/** Whether `name` is a role this config defines. */
export const isRole = (cfg: PolicyConfig, name: unknown): name is UserRole =>
  typeof name === 'string' && Object.hasOwn(resolveAccess(cfg).roles, name);

/** What a person with this role may personalise (theme, instructions). */
export function customizeFor(cfg: PolicyConfig, role: UserRole | null | undefined): string[] {
  return role && isRole(cfg, role) ? resolveAccess(cfg).roles[role].customize : [];
}

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
  return expand(role && isRole(cfg, role) ? resolveAccess(cfg).roles[role].features : undefined);
}

/** '*' or the list of model ids this role may pick. */
export function modelsFor(cfg: PolicyConfig, role: UserRole | null | undefined): string[] | '*' {
  if (!['multiuser', 'trusted-header'].includes(cfg.authMode)) return '*';
  // An unknown role (one deleted from the files by hand) gets no features, so no model either.
  if (!role || !isRole(cfg, role)) return [];
  const m = resolveAccess(cfg).roles[role].models;
  return m === '*' ? '*' : m.map(String);
}

export const MIN_PASSWORD_LENGTH = 10;
const MAX_PASSWORD_LENGTH = 1024;

/**
 * The one rule every local password meets, whoever sets it: the first admin,
 * someone joining by invitation, a person changing their own, or an admin
 * setting one for them. Null when the password is acceptable.
 */
export function passwordProblem(password: unknown): string | null {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) return `use at least ${MIN_PASSWORD_LENGTH} characters`;
  if (password.length > MAX_PASSWORD_LENGTH) return 'password is too long';
  return null;
}

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
    const known = new Set(['bootstrapAdmins', 'newUsers', 'allowRequests', 'roles', 'users', 'customize']);
    for (const k of Object.keys(a)) if (!known.has(k)) errors.push(`access.${k} is not a known setting`);
    if (a.bootstrapAdmins !== undefined && !(Array.isArray(a.bootstrapAdmins) && a.bootstrapAdmins.every((x) => typeof x === 'string' && x))) {
      errors.push('access.bootstrapAdmins must be a list of gateway user ids');
    }
    if (a.newUsers !== undefined && !['approved', 'pending'].includes(a.newUsers)) {
      errors.push("access.newUsers must be 'approved' or 'pending'");
    }
    if (a.allowRequests !== undefined && typeof a.allowRequests !== 'boolean') errors.push('access.allowRequests must be true or false');
    if (a.customize !== undefined && !(Array.isArray(a.customize) && a.customize.every((c: string) => CUSTOMIZABLE.includes(c)))) {
      errors.push(`access.customize must be a list from ${CUSTOMIZABLE.join(', ')}`);
    }
    const roles = a.roles && typeof a.roles === 'object' && !Array.isArray(a.roles) ? a.roles : {};
    if (a.roles !== undefined && roles !== a.roles) errors.push('access.roles must be an object');
    for (const [role, spec] of Object.entries<any>(roles)) {
      if (!ROLE_NAME.test(role)) { errors.push(`access.roles.${role}: a role name is lowercase letters, digits and dashes, starting with a letter (at most 32)`); continue; }
      if (!spec || typeof spec !== 'object') { errors.push(`access.roles.${role} must be an object`); continue; }
      for (const k of Object.keys(spec)) {
        if (!['features', 'models', 'customize'].includes(k)) errors.push(`access.roles.${role}.${k} is not a known setting`);
      }
      if (spec.customize !== undefined) {
        const bad = Array.isArray(spec.customize) ? spec.customize.filter((c: unknown) => !CUSTOMIZABLE.includes(c as string)) : null;
        if (!bad) errors.push(`access.roles.${role}.customize must be a list from ${CUSTOMIZABLE.join(', ')}`);
        else if (bad.length) errors.push(`access.roles.${role}.customize: unknown ${bad.map((c: unknown) => `"${c}"`).join(', ')} (known: ${CUSTOMIZABLE.join(', ')})`);
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
    const defined = [...new Set([...BUILTIN_ROLES, ...Object.keys(roles).filter((r) => ROLE_NAME.test(r))])];
    for (const [id, u] of Object.entries<any>(a.users || {})) {
      if (!u || typeof u !== 'object') { errors.push(`access.users["${id}"] must be an object`); continue; }
      if (u.role !== undefined && !defined.includes(u.role)) errors.push(`access.users["${id}"].role must be one of ${defined.join(', ')}`);
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
