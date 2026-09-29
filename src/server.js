import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { watch, existsSync } from 'node:fs';
import { dirname } from 'node:path';

import { createConfigSource, LockedError, configProblems } from './config.js';
import { McpHub } from './mcp.js';
import { isClosed, findEntry } from './models.js';
import { Store, SCHEMA_VERSION } from './store.js';
import { fingerprint, featuresFor, modelsFor } from './policy.js';
import { audit, hashPassword, applyAccessPolicy } from './auth.js';
import { resolveAuth, OWNER_ID } from './auth_gate.js';
import { json, HttpError, SECURITY_HEADERS, crossSite, serveStatic } from './http.js';
import { expandToolDef, callExpand } from './tools/context_tool.js';
import { documentToolDef, callReadDocument } from './tools/document_tool.js';
import { askToolDef, callAskUser } from './tools/ask_tool.js';
import { chatSearchToolDef, callSearchChats } from './tools/chat_search_tool.js';
import { taskToolDef, callManageTasks } from './tools/task_tool.js';
import { automationToolDef, manageAutomation } from './automation.js';
import { overrideFor } from './approval.js';
import { Retrieval } from './retrieval/retrieval.js';
import { loadEmbedder, defaultModelsDir } from './retrieval/embedding.js';
import { createRuns } from './runs.js';
import { createScheduler } from './scheduler.js';
import { authRoutes } from './routes/auth.js';
import { settingsRoutes } from './routes/settings.js';
import { mcpRoutes } from './routes/mcp.js';
import { libraryRoutes } from './routes/library.js';
import { automationRoutes } from './routes/automations.js';
import { documentRoutes } from './routes/documents.js';
import { chatRoutes } from './routes/chats.js';
import { adminRoutes } from './routes/admin.js';

const VERSION = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;

/**
 * Every API route, with the feature it needs (null: any signed-in caller, or
 * anyone for the pre-auth routes the auth gate lets through). Dispatch and
 * permission are the same table, so a route cannot ship without a decision
 * about who may use it. First match wins.
 */
function routeTable(app) {
  return [
    ...authRoutes(app), ...settingsRoutes(app), ...mcpRoutes(app), ...libraryRoutes(app),
    ...automationRoutes(app), ...documentRoutes(app), ...chatRoutes(app), ...adminRoutes(app)
  ];
}

// Handlers read the app only when called, so a stub lists the table.
export const API_ROUTES = routeTable({}).map((r) => [r.method, r.path, r.feature]);

// Fields a non-admin never sees: credentials, and where the deployment's
// trust boundary sits.
const ADMIN_ONLY_FIELDS = /^(apiKey|authPassword|sessionSecret|google|baseUrl|trusted|adminEmails|models$)/;

/**
 * Starts an instance. Everything but port/host is optional and passed to
 * createConfigSource: `config` (keys set here win and are locked in the UI),
 * `configFile` (a path, or false for none), `mcpServers`, `mcpFile`, `dbPath`.
 */
export async function start({ port = 7777, host = '127.0.0.1', ...sourceOpts } = {}) {
  const source = createConfigSource(sourceOpts);
  const initial = source.load();
  const problems = configProblems(initial);
  if (problems.length) throw new Error(problems.join('\n'));

  const store = new Store(source.dbPath(initial), { migrate: initial.autoMigrate !== false });
  // Runs live in this process, so nothing from before it can still be waiting.
  store.expireQuestions();
  if (store.migratedFrom !== null && store.migratedFrom < SCHEMA_VERSION) {
    console.log(`[tinywebui] migrated database from schema ${store.migratedFrom} to ${SCHEMA_VERSION}`);
  }
  if (initial.authMode === 'trusted-header') applyAccessPolicy(store, initial);

  // Dense/hybrid retrieval loads its embedding bundle now, so a missing
  // package, bundle or checksum mismatch stops startup with a clear message
  // instead of surfacing on the first search.
  let embedder = null;
  if (initial.retrieval.mode !== 'lexical') {
    try {
      embedder = sourceOpts.embedder || await loadEmbedder(initial.retrieval, defaultModelsDir(source.path()));
    } catch (err) { store.close(); throw err; }
    console.log(`[tinywebui] retrieval: ${initial.retrieval.mode} with ${embedder.spec?.repoId || initial.retrieval.model} (${embedder.dim} dims)`);
  }

  if (initial.authMode === 'single') {
    store.db.prepare(`INSERT INTO users (id, role, status, created_at, approved_at)
      VALUES (?, 'admin', 'approved', ?, ?) ON CONFLICT(id) DO NOTHING`).run(OWNER_ID, Date.now(), Date.now());
  }

  /**
   * What every part of the server shares. `cfg` and `hub` are replaced, not
   * mutated, when settings are saved or files reload, so read them from here
   * at use time rather than holding on to them.
   */
  const app = {
    version: VERSION,
    source,
    store,
    retrieval: new Retrieval(store, initial.retrieval, embedder),
    cfg: initial,
    hub: null,
    // 'single': the stored hash, or one made in memory from $TINYWEBUI_PASSWORD
    // (handy for containers). validateConfig already refused a plaintext one.
    passwordHash: initial.authMode === 'single' ? initial.authPassword || hashPassword(process.env.TINYWEBUI_PASSWORD) : null,

    // Every UI/API change lands in config.json (source.save) and is audited:
    // who, which keys, the new values (none of these keys are secrets), and the
    // config fingerprint before and after, to line up with a git diff.
    saveConfig(patch, by) {
      const before = fingerprint(app.cfg, source.loadMcpServers());
      const next = source.save(patch);
      audit('config.changed', { by: by ?? 'local', keys: Object.keys(patch), values: patch, before, after: fingerprint(next, source.loadMcpServers()) });
      return next;
    },
    auditMcp: (by, before) => audit('mcp.changed', { by: by ?? 'local', before, after: fingerprint(app.cfg, source.loadMcpServers()) }),

    multiUser: () => app.cfg.authMode === 'trusted-header',

    /**
     * The model a person's turns use. Tiers 1-2: the configured model. Tier 3:
     * their own pick if their role still allows it, else the configured model
     * if allowed, else the first model their role allows.
     */
    modelFor(userId, role) {
      const { cfg } = app;
      // With a catalog, everything is an entry id; a pref saved as a provider
      // id (before the catalog existed) still finds its entry.
      const known = (m) => (isClosed(cfg) ? findEntry(cfg, m)?.id : m);
      const fallback = known(cfg.model) || cfg.model;
      if (cfg.authMode !== 'trusted-header' || !userId) return fallback;
      const allowed = modelsFor(cfg, role);
      const ok = (m) => m && (allowed === '*' || allowed.includes(m));
      const pref = known(store.getPrefs(userId).model);
      if (ok(pref)) return pref;
      if (ok(fallback)) return fallback;
      // First of the role's models still enabled (a parked one never runs).
      return allowed.map(known).find(Boolean) || fallback;
    },

    /** The tools a turn gets: what is switched on, minus manage_automation for
     * anyone whose role has no automations. */
    toolsFor: (features) => app.hub.activeTools(app.cfg.disabledTools)
      .filter((t) => features.has('automations') || t.function.name !== 'manage_automation'),

    /** A stored owner's features: null (tiers 1-2) is the one person. */
    ownerFeatures: (userId) => featuresFor(app.cfg, userId ? store.getUser(userId)?.role : null),

    /** The tools panel payload: inventory plus each tool's approval state. */
    toolsView() {
      const { cfg, hub } = app;
      const inv = hub.inventory(cfg.disabledTools);
      const mark = (t) => ({ ...t, approval: overrideFor(cfg, t.name) });
      return {
        // Built-ins never ask, so they carry no approval state to show.
        internal: inv.internal,
        servers: inv.servers.map((s) => ({ ...s, tools: s.tools.map(mark) })),
        disabledTools: cfg.disabledTools || [],
        toolApproval: cfg.toolApproval
      };
    },

    configFor(auth) {
      const pub = source.public(app.cfg);
      if (auth.features.has('settings')) return pub;
      const out = {};
      for (const [k, v] of Object.entries(pub)) if (!ADMIN_ONLY_FIELDS.test(k)) out[k] = v;
      return { ...out, readOnly: true };
    },

    /** Replaces the hub wholesale: the old one's child processes are shut
     * down after the new one is up, so a rename cannot leave an orphan. */
    async swapHub(servers) {
      const old = app.hub;
      app.hub = await connectHub(servers);
      mcpText = source.readMcpFile();
      await old.close();
    },

    onRunIdle: (chatId) => app.scheduler.drain(chatId)
  };
  app.runs = createRuns(app);
  app.scheduler = createScheduler(app);
  const { retrieval, runs, scheduler } = app;

  // The built-in tools are ours, not an MCP server's, but the model should not
  // be able to tell: they are registered onto the same hub and called the same way.
  const connectHub = async (servers) =>
    (await new McpHub(servers).connect())
      .registerLocal(expandToolDef(), (args, ctx) => callExpand(args, { ...ctx, store }), { readOnly: true })
      .registerLocal(documentToolDef(), (args, ctx) => callReadDocument(args, { ...ctx, store, retrieval }), { readOnly: true })
      .registerLocal(chatSearchToolDef(), (args, ctx) => callSearchChats(args, { ...ctx, store, retrieval }), { readOnly: true })
      // Changes nothing, so it never waits for approval; never alongside
      // other calls, so a question cannot race a write it is asking about.
      .registerLocal(askToolDef(), callAskUser, { readOnly: true, idempotent: false, executionMode: 'sequential' })
      .registerLocal(taskToolDef(), (args, ctx) => callManageTasks(args, {
        ...ctx, store, onChange: (tasks) => runs.get(ctx.chatId)?.emit({ type: 'tasks', tasks })
      }), { executionMode: 'sequential' })
      .registerLocal(automationToolDef(), (args, ctx) => {
        const out = manageAutomation(args, { ...ctx, store, triggerAutomation: scheduler.trigger });
        scheduler.arm();
        return out;
      });

  app.hub = await connectHub(source.loadMcpServers());
  // What mcp.json said when the hub was last (re)built, so a reload can tell
  // a real edit from the echo of the UI's own save.
  let mcpText = source.readMcpFile();
  const serversOf = (text) => { try { const p = JSON.parse(text); return p.mcpServers || p; } catch { return {}; } };

  console.log(`[tinywebui] config: ${source.path() || '(in code, no file)'}`);
  console.log(`[tinywebui] mcp:    ${source.mcpPath() || '(in code)'}`);
  console.log(`[tinywebui] db:     ${source.dbPath(app.cfg)}`);
  console.log(`[tinywebui] model:  ${app.cfg.model} via ${app.cfg.baseUrl}`);
  console.log(`[tinywebui] tools:  ${app.hub.tools.length} from ${app.hub.clients.size} MCP server(s)`);
  console.log(`[tinywebui] policy: ${fingerprint(app.cfg, source.loadMcpServers())} (fingerprint)`);
  for (const err of app.hub.errors) console.log(`[tinywebui] mcp error: ${err}`);

  const routes = routeTable(app);

  const server = createServer(async (req, res) => {
    try {
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
      const url = new URL(req.url || '/', 'http://x');
      const { pathname } = url;
      if (crossSite(req, app.cfg)) {
        audit('request.cross_site_rejected', { method: req.method, path: pathname });
        return json(res, 403, { error: 'cross-site request refused' });
      }
      // Probes for orchestrators: no auth, nothing sensitive. /healthz says
      // the process answers; /readyz that it can serve (database reachable),
      // and which build and config it serves.
      if (req.method === 'GET' && pathname === '/healthz') return json(res, 200, { ok: true });
      if (req.method === 'GET' && pathname === '/readyz') {
        let dbOk = false;
        try { dbOk = store.ping(); } catch { /* not ready */ }
        return json(res, dbOk ? 200 : 503, { ready: dbOk, version: VERSION, fingerprint: fingerprint(app.cfg, source.loadMcpServers()) });
      }
      const auth = resolveAuth(req, pathname, app.cfg, store);
      if (auth.notFound) return json(res, 404, { error: 'not found' });
      if (auth.unauthorized) return json(res, 401, { error: 'unauthorized' });
      if (auth.disabled) return json(res, 403, { error: 'disabled' });
      if (auth.pending) return json(res, 403, { error: 'pending_approval' });

      if (!pathname.startsWith('/api/')) return serveStatic(req, res);
      for (const route of routes) {
        if (route.method !== req.method) continue;
        const match = route.path.exec(pathname);
        if (!match) continue;
        if (route.feature && !auth.features.has(route.feature)) return json(res, 403, { error: 'feature_disabled', feature: route.feature });
        return await route.handle({ req, res, auth, url, params: match.slice(1) });
      }
      return json(res, 404, { error: 'not found' });
    } catch (err) {
      if (err instanceof HttpError && err.status === 413) req.resume?.();
      if (!res.headersSent) json(res, err instanceof HttpError ? err.status : err instanceof LockedError ? 409 : 500, { error: err.message });
      else res.end();
    }
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  scheduler.arm();
  console.log(`[tinywebui] http://${host}:${port}`);
  // Anything stored before dense retrieval was on (or under another model)
  // is embedded in the background; document queries fill in on demand too.
  retrieval.backfill((msg) => console.log(`[tinywebui] retrieval: ${msg}`))
    .catch((err) => console.error(`[tinywebui] retrieval backfill failed: ${err.message}`));

  /**
   * Re-reads config.json and mcp.json after a hand or agent edit. All or
   * nothing: a file that fails to parse or validate is reported and the
   * running config stays exactly as it was. tinywebui.config.js is code and
   * is only read at startup, as is authMode (switching it live would strand
   * sessions and half the auth state).
   */
  async function reloadFromFiles(reason) {
    let next, servers, text;
    try {
      next = source.load();
      text = source.readMcpFile();
      const parsed = JSON.parse(text);
      servers = parsed.mcpServers || parsed;
      for (const [name, spec] of Object.entries(servers)) {
        if (!spec || (!spec.command && !spec.url)) throw new Error(`mcp server "${name}" needs either "command" or "url"`);
      }
    } catch (err) {
      console.error(`[tinywebui] reload rejected (${reason}): ${err.message}`);
      audit('config.reload_rejected', { reason, problems: [err.message] });
      return false;
    }
    const problems = configProblems(next);
    if (next.authMode !== app.cfg.authMode) problems.push('authMode changes need a restart');
    if (JSON.stringify(next.retrieval) !== JSON.stringify(app.cfg.retrieval)) problems.push('retrieval changes need a restart');
    if (problems.length) {
      console.error(`[tinywebui] reload rejected (${reason}):\n  ${problems.join('\n  ')}`);
      audit('config.reload_rejected', { reason, problems });
      return false;
    }
    const before = fingerprint(app.cfg, serversOf(mcpText));
    const after = fingerprint(next, servers);
    const mcpChanged = text !== mcpText;
    if (before === after && !mcpChanged) return true; // our own write, or a no-op save
    app.cfg = next;
    if (next.authMode === 'single') app.passwordHash = next.authPassword || hashPassword(process.env.TINYWEBUI_PASSWORD);
    if (next.authMode === 'trusted-header') applyAccessPolicy(store, next);
    if (mcpChanged) await app.swapHub(servers);
    scheduler.arm();
    console.log(`[tinywebui] reloaded (${reason}): policy ${after}`);
    audit('config.reloaded', { reason, before, after, mcpChanged });
    return true;
  }

  // Editors often replace a file rather than write into it, which a watch on
  // the file itself would lose; watching the folder catches both.
  const watchers = [];
  let reloadTimer = null;
  const scheduleReload = (reason) => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => { reloadFromFiles(reason).catch((err) => console.error(`[tinywebui] reload failed: ${err.message}`)); }, 300);
    reloadTimer.unref?.();
  };
  if (sourceOpts.watch !== false) {
    const targets = [source.path(), source.mcpPath()].filter(Boolean);
    for (const folder of new Set(targets.map((t) => dirname(t)))) {
      if (!existsSync(folder)) continue;
      const names = new Set(targets.filter((t) => dirname(t) === folder).map((t) => t.slice(folder.length + 1)));
      try {
        const w = watch(folder, (_, name) => { if (name && names.has(String(name))) scheduleReload('file changed'); });
        w.unref?.();
        watchers.push(w);
      } catch (err) { console.error(`[tinywebui] cannot watch ${folder}: ${err.message}`); }
    }
  }
  const onHup = () => scheduleReload('SIGHUP');
  process.on('SIGHUP', onHup);
  server.reload = reloadFromFiles;

  // Real teardown, reused two ways: on SIGINT/SIGTERM it exits the process, and
  // as `server.shutdown()` it does not -- which is what a test harness needs.
  const shutdown = async () => {
    scheduler.stop();
    clearTimeout(reloadTimer);
    for (const w of watchers) w.close();
    process.off('SIGHUP', onHup);
    await app.hub.close();
    await Promise.allSettled([...retrieval.pending.values()]);
    embedder?.close?.();
    store.close();
    await new Promise((resolve) => server.close(resolve));
  };
  process.on('SIGINT', () => shutdown().then(() => process.exit(0)));
  process.on('SIGTERM', () => shutdown().then(() => process.exit(0)));

  server.shutdown = shutdown;
  return server;
}
