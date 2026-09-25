import { existsSync } from 'node:fs';
import { createConfigSource, DEFAULTS, WRITABLE, configProblems } from './config.js';
import {
  validateConfig, fingerprint, featuresFor, modelsFor, resolveAccess, keyClass,
  FEATURES, ROLES, STATUSES, FILE_ONLY, SECRET_KEYS
} from './policy.js';
import { Store } from './store.js';

/**
 * The scriptable side of TinyWebUI: everything an agent (or a person) needs
 * to check, explain and change a deployment from files, without the UI.
 * Each command reads the same layers start() does and never writes a
 * generated sessionSecret as a side effect.
 */

const out = (v) => process.stdout.write(typeof v === 'string' ? `${v}\n` : `${JSON.stringify(v, null, 2)}\n`);
const flag = (args, name) => { const i = args.indexOf(`--${name}`); return i === -1 ? undefined : args[i + 1]; };

function loadAll(opts) {
  const source = createConfigSource(opts);
  const cfg = source.load({ persistSecret: false });
  let servers = null;
  let mcpError = null;
  try { servers = source.strictMcpServers(); } catch (err) { mcpError = `mcp.json: ${err.message}`; }
  return { source, cfg, servers: servers || {}, mcpError };
}

function mcpProblems(servers) {
  const problems = [];
  for (const [name, spec] of Object.entries(servers)) {
    if (!spec || (!spec.command && !spec.url)) problems.push(`mcp server "${name}" needs either "command" or "url"`);
  }
  return problems;
}

/** Server specs with credentials blanked: env values and header values. */
function redactServers(servers) {
  const clean = {};
  for (const [name, spec] of Object.entries(servers)) {
    const s = { ...spec };
    if (s.env) s.env = Object.fromEntries(Object.keys(s.env).map((k) => [k, '<redacted>']));
    if (s.headers) s.headers = Object.fromEntries(Object.keys(s.headers).map((k) => [k, '<redacted>']));
    clean[name] = s;
  }
  return clean;
}

const commands = {
  /** Exit 0 with the fingerprint when the files are valid; exit 1 listing every problem. */
  validate(args, opts) {
    const { source, cfg, servers, mcpError } = loadAll(opts);
    // The merged config can be valid while config.json holds a mistake that
    // code happens to shadow today; flag that too, before it surfaces later.
    const raw = source.readFile();
    const shadowed = raw.access === undefined ? []
      : validateConfig({ authMode: 'none', access: raw.access }).map((p) => `config.json: ${p}`);
    const problems = [...configProblems(cfg), ...shadowed, ...(mcpError ? [mcpError] : mcpProblems(servers))];
    if (problems.length) {
      for (const p of problems) process.stderr.write(`error: ${p}\n`);
      return 1;
    }
    out(`ok ${fingerprint(cfg, servers)}`);
    return 0;
  },

  fingerprint(args, opts) {
    const { cfg, servers } = loadAll(opts);
    out(fingerprint(cfg, servers));
    return 0;
  },

  /**
   * What is actually in effect, and how each setting can change. With
   * --role, just what that role gets. Secrets show only as set/unset.
   */
  effective(args, opts) {
    const { source, cfg, servers } = loadAll(opts);
    const locked = source.lockedKeys();
    const roleFor = (role) => ({
      features: [...featuresFor(cfg, role)],
      models: modelsFor(cfg, role)
    });
    const role = flag(args, 'role');
    if (role) {
      if (!ROLES.includes(role)) { process.stderr.write(`error: unknown role "${role}" (known: ${ROLES.join(', ')})\n`); return 1; }
      out({ role, authMode: cfg.authMode, ...roleFor(role) });
      return 0;
    }
    const settings = {};
    for (const key of Object.keys(cfg).sort()) {
      if (key === 'access') continue;
      const value = SECRET_KEYS.has(key) ? (cfg[key] ? '<set>' : '<unset>') : cfg[key];
      settings[key] = { value, change: WRITABLE.has(key) || FILE_ONLY.has(key) ? keyClass(key, locked) : 'file-only' };
    }
    const access = resolveAccess(cfg);
    out({
      fingerprint: fingerprint(cfg, servers),
      files: { config: source.path(), mcp: source.mcpPath() || '(in code)' },
      authMode: cfg.authMode,
      roles: cfg.authMode === 'trusted-header'
        ? Object.fromEntries(ROLES.map((r) => [r, roleFor(r)]))
        : { you: roleFor(null) },
      access: cfg.authMode === 'trusted-header'
        ? { bootstrapAdmins: access.bootstrapAdmins, newUsers: access.newUsers, users: access.users }
        : undefined,
      mcpServers: { locked: source.mcpLocked, servers: redactServers(servers) },
      settings
    });
    return 0;
  },

  /**
   * users list            provisioned users, with any decision pinned in the files
   * users set <id> [--role admin|user] [--status pending|approved|disabled] [--clear]
   *                       records the decision in config.json (a running
   *                       server picks it up through its file watch)
   */
  users(args, opts) {
    const [sub, externalId] = args;
    const { source, cfg } = loadAll(opts);
    const access = resolveAccess(cfg);
    if (sub === 'list' || !sub) {
      const dbFile = source.dbPath(cfg);
      const rows = dbFile !== ':memory:' && existsSync(dbFile) ? (() => {
        const store = new Store(dbFile);
        try { return store.listUsers(); } finally { store.close(); }
      })() : [];
      const seen = new Set();
      const users = rows.map((u) => {
        seen.add(u.external_id);
        return {
          externalId: u.external_id, email: u.email, name: u.name, role: u.role, status: u.status,
          chats: u.chat_count, lastLoginAt: u.last_login_at ? new Date(u.last_login_at).toISOString() : null,
          pinned: access.bootstrapAdmins.includes(u.external_id) ? 'bootstrapAdmins' : access.users[u.external_id] || null
        };
      });
      // Decisions for people who have not signed in yet still belong in the list.
      for (const [id, pin] of Object.entries(access.users)) if (!seen.has(id)) users.push({ externalId: id, pinned: pin, provisioned: false });
      for (const id of access.bootstrapAdmins) if (!seen.has(id)) users.push({ externalId: id, pinned: 'bootstrapAdmins', provisioned: false });
      out(users);
      return 0;
    }
    if (sub === 'set') {
      if (!externalId) { process.stderr.write('usage: tinywebui users set <gateway user id> [--role r] [--status s] [--clear]\n'); return 1; }
      if (!source.path()) { process.stderr.write('error: no config file to write to\n'); return 1; }
      if (source.codeAccessUsers()[externalId] || access.bootstrapAdmins.includes(externalId)) {
        process.stderr.write(`error: "${externalId}" is declared in tinywebui.config.js; change it there\n`);
        return 1;
      }
      const role = flag(args, 'role');
      const status = flag(args, 'status');
      const clear = args.includes('--clear');
      if (!clear && role === undefined && status === undefined) { process.stderr.write('error: nothing to set (use --role, --status or --clear)\n'); return 1; }
      if (role !== undefined && !ROLES.includes(role)) { process.stderr.write(`error: role must be one of ${ROLES.join(', ')}\n`); return 1; }
      if (status !== undefined && !STATUSES.includes(status)) { process.stderr.write(`error: status must be one of ${STATUSES.join(', ')}\n`); return 1; }
      const file = source.readFile();
      const fileAccess = file.access && typeof file.access === 'object' ? file.access : {};
      const users = { ...(fileAccess.users || {}) };
      if (clear) delete users[externalId];
      else users[externalId] = { ...(users[externalId] || {}), ...(role ? { role } : {}), ...(status ? { status } : {}) };
      source.writeFile({ ...file, access: { ...fileAccess, users } });
      out(clear ? `cleared ${externalId}` : `${externalId}: ${JSON.stringify(users[externalId])}`);
      return 0;
    }
    process.stderr.write(`error: unknown users command "${sub}" (list, set)\n`);
    return 1;
  },

  schema() {
    out(configSchema());
    return 0;
  }
};

/** A JSON Schema for config.json (and the `config` block of tinywebui.config.js). */
export function configSchema() {
  const typeOf = (v) => (v === null ? ['number', 'null'] : Array.isArray(v) ? 'array' : typeof v);
  const properties = {};
  for (const [k, v] of Object.entries(DEFAULTS)) {
    properties[k] = {
      type: typeOf(v),
      'x-change': FILE_ONLY.has(k) ? 'file-only' : WRITABLE.has(k) ? 'editable (UI writes it back here)' : 'file-only'
    };
  }
  properties.authMode = { enum: ['none', 'single', 'trusted-header'], 'x-change': 'file-only' };
  properties.toolApproval = { enum: ['writes', 'all', 'off'], 'x-change': 'editable (UI writes it back here)' };
  properties.trustedProxyCidrs = { type: 'array', items: { type: 'string' }, 'x-change': 'file-only' };
  const featureList = { oneOf: [{ const: '*' }, { type: 'array', items: { enum: FEATURES }, uniqueItems: true }] };
  const role = {
    type: 'object', additionalProperties: false,
    properties: { features: featureList, models: { oneOf: [{ const: '*' }, { type: 'array', items: { type: 'string' } }] } }
  };
  properties.access = {
    type: 'object', additionalProperties: false, 'x-change': 'file-only (admins write access.users back)',
    properties: {
      bootstrapAdmins: { type: 'array', items: { type: 'string' }, description: 'Gateway user ids that are always approved admins.' },
      newUsers: { enum: ['approved', 'pending'] },
      roles: { type: 'object', additionalProperties: false, properties: Object.fromEntries(ROLES.map((r) => [r, role])) },
      users: {
        type: 'object',
        additionalProperties: {
          type: 'object', additionalProperties: false,
          properties: { role: { enum: ROLES }, status: { enum: STATUSES } }
        }
      }
    }
  };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'TinyWebUI configuration',
    type: 'object',
    properties
  };
}

export async function runCli(command, args, opts) {
  const fn = commands[command];
  if (!fn) return null;
  return fn(args, opts);
}
