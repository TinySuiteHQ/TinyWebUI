import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PRESETS, resolveModel, findOnnxFile, sha256File, loadEmbedder, defaultModelsDir } from './retrieval/embedding.js';
import { createConfigSource, DEFAULTS, WRITABLE, configProblems } from './config/config.js';
import {
  validateConfig, fingerprint, featuresFor, modelsFor, resolveAccess, keyClass,
  FEATURES, ROLES, STATUSES, FILE_ONLY, SECRET_KEYS
} from './access/policy.js';
import { Store, SCHEMA_VERSION, MigrationRequiredError } from './store/index.js';

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
  },

  /**
   * models pull <fast|balanced|quality|multilingual> [--dir path]
   *   Fetches a preset embedding bundle from Hugging Face -- the same repos
   *   and files TinySearch uses (multilingual is TinyWebUI's own) -- into the models folder, then prints the
   *   model's sha256 to pin as retrieval.modelSha256. The only command that
   *   ever downloads a model; the server never does.
   * models verify
   *   Loads the configured bundle exactly as startup would and embeds a probe.
   */
  async models(args, opts) {
    const [sub, name] = args;
    const { source, cfg } = loadAll(opts);
    const modelsDir = defaultModelsDir(source.path());
    if (sub === 'pull') {
      const preset = PRESETS[name];
      if (!preset) { process.stderr.write(`usage: tinywebui models pull <${Object.keys(PRESETS).join('|')}> [--dir path]\n`); return 1; }
      const dest = flag(args, 'dir') ? join(flag(args, 'dir')) : join(modelsDir, preset.localDir);
      const tmp = `${dest}.partial`;
      rmSync(tmp, { recursive: true, force: true });
      process.stderr.write(`[tinywebui] fetching ${preset.repoId} into ${dest} (see its Hugging Face model card for the license)\n`);
      for (const file of preset.files) {
        const url = `https://huggingface.co/${preset.repoId}/resolve/main/${file}`;
        const res = await fetch(url);
        if (res.status === 404 && file !== preset.onnxPaths[0] && file !== 'tokenizer.json') continue; // companion files are optional
        if (!res.ok) { rmSync(tmp, { recursive: true, force: true }); process.stderr.write(`error: ${res.status} fetching ${url}\n`); return 1; }
        const target = join(tmp, file);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, Buffer.from(await res.arrayBuffer()));
        process.stderr.write(`  ${file}\n`);
      }
      rmSync(dest, { recursive: true, force: true });
      mkdirSync(dirname(dest), { recursive: true });
      renameSync(tmp, dest);
      const onnx = findOnnxFile({ ...preset, dir: dest });
      out({ model: name, dir: dest, onnx, sha256: await sha256File(onnx) });
      return 0;
    }
    if (sub === 'verify') {
      if (cfg.retrieval.mode === 'lexical') { out('retrieval.mode is lexical: no embedding model needed'); return 0; }
      const e = await loadEmbedder(cfg.retrieval, modelsDir);
      out({ model: e.spec.name, dir: e.spec.dir, sha256: e.sha256, pinned: Boolean(cfg.retrieval.modelSha256), dims: e.dim, key: e.key });
      e.close?.();
      return 0;
    }
    process.stderr.write('usage: tinywebui models pull <preset> [--dir path] | models verify\n');
    return 1;
  },

  config(args, opts) {
    if (args[0] !== 'show') { process.stderr.write('usage: tinywebui config show [--role user|admin]\n'); return 1; }
    return commands.effective(args.slice(1), opts);
  },

  /**
   * Brings the database to the current schema, as a deliberate deployment
   * step (pair it with autoMigrate: false). --check changes nothing and
   * exits 1 when a migration is due.
   */
  migrate(args, opts) {
    const { source, cfg } = loadAll(opts);
    const file = source.dbPath(cfg);
    if (file === ':memory:') { out('in-memory database: nothing to migrate'); return 0; }
    if (args.includes('--check')) {
      if (!existsSync(file)) { out(`no database yet at ${file}; it will be created at schema ${SCHEMA_VERSION}`); return 0; }
      try {
        new Store(file, { migrate: false }).close();
        out(`up to date: schema ${SCHEMA_VERSION}`);
        return 0;
      } catch (err) {
        if (!(err instanceof MigrationRequiredError)) throw err;
        process.stderr.write(`${err.message}\n`);
        return 1;
      }
    }
    const store = new Store(file);
    try {
      out(store.migratedFrom === null ? `created ${file} at schema ${SCHEMA_VERSION}`
        : store.migratedFrom === SCHEMA_VERSION ? `up to date: schema ${SCHEMA_VERSION}`
        : `migrated ${file} from schema ${store.migratedFrom} to ${SCHEMA_VERSION}`);
    } finally { store.close(); }
    return 0;
  },

  /**
   * Checks everything a deployment depends on, one line per check, and
   * exits 1 if any failed: node version, config, database, the model
   * endpoint, and each enabled MCP server (connected, then closed).
   */
  async doctor(args, opts) {
    const checks = [];
    const check = async (name, fn) => {
      try { const detail = await fn(); checks.push({ check: name, ok: true, ...(detail ? { detail } : {}) }); }
      catch (err) { checks.push({ check: name, ok: false, detail: err.message }); }
    };
    let loaded;
    await check('node', () => {
      // node:sqlite is available without a flag from 22.13.
      const [major, minor] = process.versions.node.split('.').map(Number);
      if (major < 22 || (major === 22 && minor < 13)) throw new Error(`node ${process.versions.node}; TinyWebUI needs 22.13 or later`);
      return process.versions.node;
    });
    await check('config', () => {
      loaded = loadAll(opts);
      const problems = [...configProblems(loaded.cfg), ...(loaded.mcpError ? [loaded.mcpError] : mcpProblems(loaded.servers))];
      if (problems.length) throw new Error(problems.join('; '));
      return `fingerprint ${fingerprint(loaded.cfg, loaded.servers)}`;
    });
    if (loaded) {
      const { source, cfg, servers } = loaded;
      await check('database', () => {
        const file = source.dbPath(cfg);
        if (file === ':memory:') return 'in memory';
        if (!existsSync(file)) return `${file} will be created`;
        let store;
        try { store = new Store(file, { migrate: false }); } catch (err) {
          // Behind is fine when startup is allowed to migrate; it is only a
          // failure for deployments that migrate as a separate step.
          if (err instanceof MigrationRequiredError && cfg.autoMigrate !== false && !/newer/.test(err.message)) {
            return `${err.message.split(':')[0]}; will migrate on start (autoMigrate)`;
          }
          throw err;
        }
        try { return `${file} at schema ${store.schemaVersion()}`; } finally { store.close(); }
      });
      await check('model endpoint', async () => {
        const r = await fetch(`${cfg.baseUrl}/models`, {
          headers: cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {},
          signal: AbortSignal.timeout(8000)
        });
        // Some OpenAI-compatible servers have no /models; reachable is what counts.
        if (r.status >= 500) throw new Error(`${r.status} from ${cfg.baseUrl}/models`);
        if (r.status === 401 || r.status === 403) throw new Error(`${r.status} from ${cfg.baseUrl}: check apiKey`);
        return `${cfg.baseUrl} answered ${r.status}`;
      });
      await check('retrieval', async () => {
        if (cfg.retrieval.mode === 'lexical') return 'lexical (SQLite FTS5)';
        const e = await loadEmbedder(cfg.retrieval, defaultModelsDir(source.path()));
        e.close?.();
        return `${cfg.retrieval.mode} with ${e.spec.repoId}, ${e.dim} dims${cfg.retrieval.modelSha256 ? ', checksum pinned' : ', checksum NOT pinned (set retrieval.modelSha256)'}`;
      });
      const { McpHub } = await import('./mcp.js');
      for (const [name, spec] of Object.entries(servers)) {
        if (spec?.disabled) { checks.push({ check: `mcp ${name}`, ok: true, detail: 'disabled' }); continue; }
        await check(`mcp ${name}`, async () => {
          const hub = await new McpHub({ [name]: spec }).connect();
          try {
            if (hub.errors.length) throw new Error(hub.errors.join('; '));
            return `${hub.tools.length} tool(s)`;
          } finally { await hub.close(); }
        });
      }
    }
    for (const c of checks) out(JSON.stringify(c));
    return checks.every((c) => c.ok) ? 0 : 1;
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
  properties.retrieval = {
    type: 'object', additionalProperties: false, 'x-change': 'file-only (restart to apply)',
    properties: {
      mode: { enum: ['lexical', 'dense', 'hybrid'] },
      model: { type: 'string', description: 'fast | balanced | quality | multilingual, or a name with modelDir' },
      modelDir: { type: 'string' },
      modelSha256: { type: 'string', pattern: '^([0-9a-fA-F]{64})?$' },
      denseWeight: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1 },
      rrfK: { type: 'integer', minimum: 0 },
      queryPrefix: { type: 'string' },
      documentPrefix: { type: 'string' }
    }
  };
  const num = { type: ['number', 'null'] };
  properties.models = {
    type: 'array', 'x-change': 'file-only',
    description: 'The model catalog. Empty: any model id. Listed: only these can be picked, by id, shown by label.',
    items: {
      type: 'object', additionalProperties: false, required: ['id'],
      properties: {
        id: { type: 'string', description: 'Stable handle: what model, roles and prefs name.' },
        model: { type: 'string', description: "Provider model id; defaults to id." },
        label: { type: 'string', description: 'What people see in the picker.' },
        description: { type: 'string' },
        enabled: { type: 'boolean', description: 'false: keep the settings, hide and refuse the model.' },
        systemPrompt: { type: 'string' },
        temperature: num,
        maxTokens: num,
        maxToolRounds: { type: 'integer', minimum: 0 },
        cacheMode: { enum: ['auto', 'implicit', 'explicit', 'rolling', 'off'] },
        cacheTtl: { enum: ['5m', '1h'] },
        extraBody: { type: 'object', description: 'Merged over the global extraBody.' }
      }
    }
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
