import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { watch, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';

import { createConfigSource, LockedError, configProblems } from './config.js';
import { McpHub } from './mcp.js';
import { runChat } from './llm.js';
import { effectiveConfig, isClosed, enabledEntries, findEntry, publicEntry, labelFor } from './models.js';
import { Store, toView, ALL_USERS, SCHEMA_VERSION } from './store.js';
import { validateConfig, fingerprint, featuresFor, modelsFor, resolveAccess } from './policy.js';
import {
  getSessionUser, resolveTrustedUser, destroyUserSessions, audit, hashPassword, verifyPassword, applyAccessPolicy,
  createSession, destroySession, sessionToken, sessionCookie, clearCookie, isSecureRequest
} from './auth.js';
import { expandToolDef, callExpand } from './context_tool.js';
import { documentToolDef, callReadDocument } from './document_tool.js';
import { askToolDef, callAskUser } from './ask_tool.js';
import { taskToolDef, callManageTasks } from './task_tool.js';
import { Retrieval } from './retrieval.js';
import { loadEmbedder, defaultModelsDir } from './embedding.js';
import { extractText } from './documents.js';
import { normalizeImage } from './images.js';
import { overrideFor, setOverride } from './approval.js';
import { automationToolDef, manageAutomation, nextSchedule, runMessage, validateSchedule } from './automation.js';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** The inline note that tells the model an id it can read_document on. */
/** `newChatTitle` on an automation request: undefined when absent, false when
 * present but unusable, otherwise the trimmed title. */
function newChatTitleOf(body) {
  if (body.newChatTitle === undefined || body.newChatTitle === null) return undefined;
  const title = String(body.newChatTitle).trim();
  return title && title.length <= 120 ? title : false;
}

function attachmentNote(doc) {
  return `\n\n[Attached document: "${doc.filename}" (id: ${doc.id}, ${doc.char_len.toLocaleString('en-US')} chars). Use read_document to search or read it.]`;
}

/** Decodes and normalizes one uploaded image; null on anything unusable. */
async function normalizeUpload(mimeRaw, dataBase64) {
  const mime = String(mimeRaw || '');
  if (!mime.startsWith('image/') && mime !== '') return null;
  let buf;
  try { buf = Buffer.from(String(dataBase64 || ''), 'base64'); } catch { return null; }
  if (!buf.length || buf.length > MAX_IMAGE_BYTES) return null;
  try {
    const normalized = await normalizeImage(buf, mime);
    return normalized && { mime: normalized.mime, data: normalized.data.toString('base64') };
  } catch {
    return null;
  }
}

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

const VERSION = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;

/** An error that carries its own HTTP status to the handler's catch. */
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Body caps. Most requests are a few KB; uploads and turns with images carry
// base64 (4/3 of the file), so they get room for their own per-file limits.
const BODY_LIMIT = 1024 * 1024;
const UPLOAD_LIMIT = 8 * 1024 * 1024;       // one 5 MB file, base64
const TURN_LIMIT = 60 * 1024 * 1024;        // up to 8 images of 5 MB, base64
const IMPORT_LIMIT = 50 * 1024 * 1024;

/** Reads a JSON body, refusing more than `limit` bytes (413) or bad JSON (400). */
async function readJson(req, limit = BODY_LIMIT) {
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
const SECURITY_HEADERS = {
  'content-security-policy': [
    "default-src 'self'", "script-src 'self'", "connect-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
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
function crossSite(req, cfg) {
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

async function serveStatic(req, res) {
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

/**
 * Starts an instance. Everything but port/host is optional and passed to
 * createConfigSource: `config` (keys set here win and are locked in the UI),
 * `configFile` (a path, or false for none), `mcpServers`, `mcpFile`, `dbPath`.
 */
// Every API route and the feature it needs; null means any signed-in caller
// (or anyone, for the pre-auth routes the auth gate lets through).
const ROUTES = [
  ['GET', /^\/api\/auth\/me$/, null],
  ['GET', /^\/api\/meta$/, null],
  ['POST', /^\/api\/auth\/(login|logout)$/, null],
  ['GET', /^\/api\/config$/, null],
  ['POST', /^\/api\/config$/, 'settings'],
  ['GET', /^\/api\/models$/, 'model-picker'],
  ['POST', /^\/api\/me\/prefs$/, 'model-picker'],
  ['GET', /^\/api\/tools$/, 'tools'],
  ['POST', /^\/api\/tools\/(approval|toggle)$/, 'tools'],
  ['*', /^\/api\/mcp(\/servers\/[^/]+\/toggle)?$/, 'mcp'],
  ['GET', /^\/api\/search$/, 'search'],
  ['GET', /^\/api\/usage$/, 'statistics'],
  ['*', /^\/api\/folders$/, 'folders'],
  ['POST', /^\/api\/chats\/[\w.-]+\/organize$/, 'folders'],
  ['*', /^\/api\/automations(\/[\w.-]+(\/(runs|trigger))?)?$/, 'automations'],
  ['POST', /^\/api\/chats\/[\w.-]+\/documents$/, 'attachments'],
  ['GET', /^\/api\/documents\/[\w.-]+$/, 'attachments'],
  ['POST', /^\/api\/images\/normalize$/, 'images'],
  ['*', /^\/api\/chats(\/import)?$/, 'chat'],
  ['*', /^\/api\/chats\/[\w.-]+(\/(stream|stop|approve|answer|edit|queue(\/[\w.-]+)?))?$/, 'chat'],
  ['POST', /^\/api\/chat$/, 'chat'],
  ['*', /^\/api\/admin\/users(\/[\w-]+)?$/, 'admin'],
  ['GET', /^\/api\/admin\/(users\/[\w-]+\/chats|chats\/[\w.-]+|documents\/[\w.-]+)$/, 'oversight'],
];
export const API_ROUTES = ROUTES;

/** Who to name in the audit log for a change: the user, or 'local' (tiers 1-2). */
const actor = (auth) => (auth.user?.id && auth.user.id !== 'owner' ? auth.user.id : 'local');

function adminUserView(u) {
  return {
    id: u.id, email: u.email, name: u.name ?? null, role: u.role, status: u.status,
    createdAt: u.created_at, lastLoginAt: u.last_login_at, chatCount: u.chat_count ?? null
  };
}

export async function start({ port = 7777, host = '127.0.0.1', ...sourceOpts } = {}) {
  const source = createConfigSource(sourceOpts);
  // Every UI/API change lands in config.json (source.save) and is audited:
  // who, which keys, the new values (none of these keys are secrets), and the
  // config fingerprint before and after, to line up with a git diff.
  const saveConfig = (patch, by) => {
    const before = fingerprint(cfg, source.loadMcpServers());
    const next = source.save(patch);
    audit('config.changed', { by: by ?? 'local', keys: Object.keys(patch), values: patch, before, after: fingerprint(next, source.loadMcpServers()) });
    return next;
  };
  const auditMcp = (by, before) => audit('mcp.changed', { by: by ?? 'local', before, after: fingerprint(cfg, source.loadMcpServers()) });
  const publicConfig = (c) => source.public(c);
  const { dbPath, readMcpFile, saveMcpFile } = source;
  let cfg = source.load();
  const problems = configProblems(cfg);
  if (problems.length) throw new Error(problems.join('\n'));
  // 'single': the stored hash, or one made in memory from $TINYWEBUI_PASSWORD
  // (handy for containers). validateConfig above already refused a plaintext one.
  let passwordHash = cfg.authMode === 'single'
    ? cfg.authPassword || hashPassword(process.env.TINYWEBUI_PASSWORD)
    : null;
  const store = new Store(dbPath(cfg), { migrate: cfg.autoMigrate !== false });
  // Runs live in this process, so nothing from before it can still be waiting.
  store.expireQuestions();
  if (store.migratedFrom !== null && store.migratedFrom < SCHEMA_VERSION) {
    console.log(`[tinywebui] migrated database from schema ${store.migratedFrom} to ${SCHEMA_VERSION}`);
  }
  if (cfg.authMode === 'trusted-header') applyAccessPolicy(store, cfg);

  // Dense/hybrid document retrieval loads its embedding bundle now, so a
  // missing package, bundle or checksum mismatch stops startup with a clear
  // message instead of surfacing on the first document question.
  let embedder = null;
  if (cfg.retrieval.mode !== 'lexical') {
    try {
      embedder = sourceOpts.embedder || await loadEmbedder(cfg.retrieval, defaultModelsDir(source.path()));
    } catch (err) { store.close(); throw err; }
    console.log(`[tinywebui] retrieval: ${cfg.retrieval.mode} with ${embedder.spec?.repoId || cfg.retrieval.model} (${embedder.dim} dims)`);
  }
  const retrieval = new Retrieval(store, cfg.retrieval, embedder);
  // The one account behind a 'single' password. Sessions hang off it; data
  // stays unowned (ALL_USERS), so switching between 'none' and 'single'
  // never hides a chat.
  const OWNER_ID = 'owner';
  if (cfg.authMode === 'single') {
    store.db.prepare(`INSERT INTO users (id, role, status, created_at, approved_at)
      VALUES (?, 'admin', 'approved', ?, ?) ON CONFLICT(id) DO NOTHING`).run(OWNER_ID, Date.now(), Date.now());
  }
  // Failed logins per client address: 5 misses locks that address out for 15 minutes.
  const loginFailures = new Map();
  const LOGIN_MAX = 5;
  const LOGIN_WINDOW_MS = 15 * 60_000;
  let armScheduler = () => {};
  let triggerAutomation = async () => { throw new Error('manual triggering is unavailable'); };
  let drainManualTriggers = () => {};
  const pendingManualTriggers = new Map();

  // context_expand is ours, not an MCP server's, but the model should not be
  // able to tell: it is registered onto the same hub and called the same way.
  const connectHub = async (servers) =>
    (await new McpHub(servers).connect())
      .registerLocal(expandToolDef(), (args, ctx) => callExpand(args, { ...ctx, store }), { readOnly: true })
      .registerLocal(documentToolDef(), (args, ctx) => callReadDocument(args, { ...ctx, store, retrieval }), { readOnly: true })
      // Changes nothing, so it never waits for approval; never alongside
      // other calls, so a question cannot race a write it is asking about.
      .registerLocal(askToolDef(), callAskUser, { readOnly: true, idempotent: false, executionMode: 'sequential' })
      .registerLocal(taskToolDef(), (args, ctx) => callManageTasks(args, {
        ...ctx, store, onChange: (tasks) => runs.get(ctx.chatId)?.emit({ type: 'tasks', tasks })
      }), { executionMode: 'sequential' })
      .registerLocal(automationToolDef(), (args, ctx) => {
        const out = manageAutomation(args, { ...ctx, store, triggerAutomation });
        armScheduler();
        return out;
      });

  let hub = await connectHub(source.loadMcpServers());
  // What mcp.json said when the hub was last (re)built, so a reload can tell
  // a real edit from the echo of the UI's own save.
  let mcpText = readMcpFile();
  const serversOf = (text) => { try { const p = JSON.parse(text); return p.mcpServers || p; } catch { return {}; } };

  console.log(`[tinywebui] config: ${source.path() || '(in code, no file)'}`);
  console.log(`[tinywebui] mcp:    ${source.mcpPath() || '(in code)'}`);
  console.log(`[tinywebui] db:     ${dbPath(cfg)}`);
  console.log(`[tinywebui] model:  ${cfg.model} via ${cfg.baseUrl}`);
  console.log(`[tinywebui] tools:  ${hub.tools.length} from ${hub.clients.size} MCP server(s)`);
  console.log(`[tinywebui] policy: ${fingerprint(cfg, source.loadMcpServers())} (fingerprint)`);
  for (const err of hub.errors) console.log(`[tinywebui] mcp error: ${err}`);

  /**
   * Turns in flight, by chat id.
   *
   * A turn used to live inside its HTTP response: the request's `close` event
   * aborted it, so closing the tab halfway through a twelve-round research run
   * threw the whole thing away, tokens already spent and all. A run is owned by
   * the server instead. The response is only a viewer -- it can come and go,
   * and more than one can watch at once.
   *
   * Every event is kept as well as broadcast, so a viewer that arrives late (a
   * reload, a second tab) replays what it missed from `from` and then follows
   * the rest live. The buffer is per-turn and dropped a few minutes after the
   * turn ends; the transcript itself lives in the store, as it always did.
   */
  const runs = new Map();
  const isRunning = (chatId) => {
    const run = runs.get(chatId);
    return Boolean(run && !run.done);
  };

  const RETAIN_MS = 5 * 60 * 1000;

  /** The tools panel payload: inventory plus each tool's approval state. */
  // Cached per endpoint for a few minutes: OpenRouter's list is large and the
  // picker is opened far more often than the catalogue changes.
  let modelCache = null;
  const listModels = async () => {
    const key = `${cfg.baseUrl}|${Boolean(cfg.apiKey)}`;
    if (modelCache?.key === key && Date.now() - modelCache.at < 5 * 60_000) return modelCache.value;
    let value;
    try {
      const r = await fetch(`${cfg.baseUrl}/models`, {
        headers: cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {},
        signal: AbortSignal.timeout(8000)
      });
      if (!r.ok) throw new Error(`${r.status} from ${cfg.baseUrl}/models`);
      const body = await r.json();
      const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
      const models = rows
        .map((m) => ({ id: m.id || m.name, name: m.name && m.name !== m.id ? m.name : null }))
        .filter((m) => typeof m.id === 'string' && m.id)
        .sort((a, b) => a.id.localeCompare(b.id));
      value = { supported: models.length > 0, models };
    } catch (err) {
      value = { supported: false, models: [], error: err.message };
    }
    modelCache = { key, at: Date.now(), value };
    return value;
  };

  const toolsView = () => {
    const inv = hub.inventory(cfg.disabledTools);
    const mark = (t) => ({ ...t, approval: overrideFor(cfg, t.name) });
    return {
      // Built-ins never ask, so they carry no approval state to show.
      internal: inv.internal,
      servers: inv.servers.map((s) => ({ ...s, tools: s.tools.map(mark) })),
      disabledTools: cfg.disabledTools || [],
      toolApproval: cfg.toolApproval
    };
  };

  /**
   * The model a person's turns use. Tiers 1-2: the configured model. Tier 3:
   * their own pick if their role still allows it, else the configured model
   * if allowed, else the first model their role allows.
   */
  function modelFor(userId, role) {
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
  }

  /** Tells everyone watching a chat's run what is queued now. */
  const announceQueue = (chatId) => runs.get(chatId)?.emit({ type: 'queue', items: store.listQueued(chatId) });

  /**
   * `lead` is a queued follow-up that starts this run: stored after baseCount
   * and sent as an event, so a live view and a reload each show it once.
   */
  function startRun({ chat, tools, onFinish, historyFromSeq = null, unattended = false, model = null, lead = null }) {
    const run = {
      events: [],
      subs: new Set(),
      ac: new AbortController(),
      done: false,
      // Where the store stood when the turn began, including the user message
      // that started it. A client reopening mid-turn replays up to here and
      // plays the events over the top.
      baseCount: store.messages(chat.id).length,
      // Tool calls waiting on the user, by call id -> { name, resolve }.
      approvals: new Map(),
      // The ask_user question waiting on the user: { id, settle }, or null.
      question: null,
      unattended
    };
    runs.set(chat.id, run);
    // A stop settles every open question as "no", so the loop can unwind
    // instead of waiting forever on a prompt nobody will answer now.
    run.ac.signal.addEventListener('abort', () => {
      for (const { resolve } of run.approvals.values()) resolve('deny');
      run.approvals.clear();
      // Stop ends the run; the question is closed so no late answer revives it.
      run.question?.settle('cancelled');
    }, { once: true });
    // Unattended runs get no asker: the loop refuses gated calls itself.
    const approve = unattended ? null : ({ id, name }) =>
      new Promise((resolve) => run.approvals.set(id, { name, resolve }));

    /**
     * Puts one ask_user question to the user and waits: for an answer, a
     * skip, the timeout, or a stop. Persisted first, so the row decides who
     * settled it; the timer is read from the live config at ask time.
     */
    const askUser = unattended ? null : ({ question, choices, allowFreeText }) => {
      if (run.ac.signal.aborted) return Promise.resolve({ answered: false, reason: 'cancelled' });
      // Calls are sequential, so a second one can only arrive after the first
      // settled; this is the guard should that ever change.
      if (run.question) return Promise.resolve({ answered: false, reason: 'busy' });
      const id = randomUUID();
      const seconds = Math.max(0, Number(cfg.askUserTimeoutSeconds) || 0);
      const deadline = seconds ? Date.now() + seconds * 1000 : null;
      store.addQuestion(chat.id, { id, question, choices, allowFreeText, deadline });
      return new Promise((resolve) => {
        let timer = null;
        const settle = (status, answer = null) => {
          if (!store.settleQuestion(id, status, answer)) return false;
          clearTimeout(timer);
          if (run.question?.id === id) run.question = null;
          emit({ type: 'question_done', id, status, answer });
          resolve(status === 'answered' ? { answered: true, answer } : { answered: false, reason: status });
          return true;
        };
        run.question = { id, choices, allowFreeText, settle };
        if (deadline) timer = setTimeout(() => settle('timeout'), seconds * 1000);
        emit({ type: 'question', id, question, choices, allowFreeText, deadline, timeoutSeconds: seconds });
      });
    };

    const emit = (event) => {
      run.events.push(event);
      for (const sub of run.subs) {
        try { sub.write(`data: ${JSON.stringify(event)}\n\n`); } catch { run.subs.delete(sub); }
      }
    };

    run.emit = emit;
    emit({ type: 'chat', id: chat.id, title: chat.title });
    if (lead != null) {
      store.addMessage(chat.id, { role: 'user', content: lead });
      emit({ type: 'user', content: lead });
    }
    emit({ type: 'queue', items: store.listQueued(chat.id) });

    // Steering is interactive input: an unattended run never takes any, so
    // it cannot swallow what someone typed into a chat an automation shares.
    const takeInput = unattended ? null : () => {
      const items = store.takeQueued(chat.id, { kind: 'steer' });
      if (items.length) emit({ type: 'queue', items: store.listQueued(chat.id) });
      return items.map((i) => i.content);
    };

    run.promise = (async () => {
      try {
        await runChat({ cfg: effectiveConfig(cfg, model), chatId: chat.id, store, tools, hub, emit, signal: run.ac.signal, historyFromSeq, unattended, approve, takeInput, askUser });
      } catch (err) {
        emit({ type: 'error', error: run.ac.signal.aborted ? 'Stopped.' : err.message });
      } finally {
        store.touchChat(chat.id);
        run.done = true;
        // The run would go idle here, so the oldest queued item starts the
        // next one -- in this same synchronous block, so nothing queued before
        // `done` flipped can be missed. A stop or failure delivers nothing:
        // the queue stays put and the client hands it back to the composer.
        const ok = !run.events.some((event) => event.type === 'error') && !run.ac.signal.aborted;
        const next = ok && !unattended ? store.takeQueued(chat.id, { first: true })[0] : null;
        if (next) {
          emit({ type: 'next_run' });
          startRun({ chat, tools, model, lead: next.content });
        }
        try { onFinish?.({
          ok: !run.events.some((event) => event.type === 'error') && !run.ac.signal.aborted,
          error: run.events.find((event) => event.type === 'error')?.error || (run.ac.signal.aborted ? 'Stopped.' : null),
          result: store.messages(chat.id).slice(run.baseCount).filter((m) => m.role === 'assistant').at(-1)?.content || ''
        }); } catch { /* a run observer cannot disrupt chat teardown */ }
        for (const sub of run.subs) { try { sub.end(); } catch { /* already gone */ } }
        run.subs.clear();
        // Held briefly so a client reconnecting a second later still gets the
        // tail of the turn rather than a 404.
        setTimeout(() => { if (runs.get(chat.id) === run) runs.delete(chat.id); }, RETAIN_MS).unref();
        queueMicrotask(() => drainManualTriggers(chat.id));
      }
    })();

    return run;
  }

  /** The tools a turn gets: what is switched on, minus manage_automation for
   * anyone whose role has no automations. */
  const toolsFor = (features) => hub.activeTools(cfg.disabledTools)
    .filter((t) => features.has('automations') || t.function.name !== 'manage_automation');

  /** A stored owner's features: null (tiers 1-2) is the one person. */
  const ownerFeatures = (userId) => featuresFor(cfg, userId ? store.getUser(userId)?.role : null);

  function launchAutomationRun(automation, runId) {
    // Nobody is at the keyboard to be turned away, so a disabled or pending
    // owner is checked here: their schedules stop the moment their access does.
    if (automation.userId && (store.getUser(automation.userId)?.status !== 'approved' || !ownerFeatures(automation.userId).has('automations'))) {
      store.updateAutomationRun(runId, { status: 'skipped', finishedAt: Date.now(), error: 'Owner account is not active.' });
      return true;
    }
    const chat = store.getChat(automation.chatId, automation.userId);
    if (!chat) {
      store.updateAutomationRun(runId, { status: 'failed', finishedAt: Date.now(), error: 'Target chat no longer exists.' });
      return false;
    }
    if (isRunning(chat.id)) return false;
    const firstSeq = store.addMessage(chat.id, { role: 'user', content: runMessage(automation) });
    store.updateAutomationRun(runId, { status: 'running', startedAt: Date.now() });
    startRun({ chat, model: modelFor(automation.userId, automation.userId ? store.getUser(automation.userId)?.role : null), tools: toolsFor(ownerFeatures(automation.userId)), onFinish: ({ ok, error, result }) => {
      store.updateAutomationRun(runId, {
        status: ok ? 'completed' : 'failed', finishedAt: Date.now(),
        result: String(result || '').slice(0, 200000), error: error ? String(error).slice(0, 1000) : null
      });
      armScheduler();
    }, historyFromSeq: firstSeq, unattended: true });
    return true;
  }

  triggerAutomation = async (automation, userId) => {
    const owned = store.getAutomation(automation.id, userId);
    if (!owned) throw new Error('no such automation');
    const runId = store.addAutomationRun(owned.id, Date.now(), 'queued', 'manual');
    if (isRunning(owned.chatId)) {
      const queue = pendingManualTriggers.get(owned.chatId) || [];
      queue.push({ automationId: owned.id, userId, runId });
      pendingManualTriggers.set(owned.chatId, queue);
      return { runId, status: 'queued', chatId: owned.chatId };
    }
    launchAutomationRun(owned, runId);
    return { runId, status: 'running', chatId: owned.chatId };
  };

  drainManualTriggers = (chatId) => {
    if (isRunning(chatId)) return;
    const queue = pendingManualTriggers.get(chatId);
    if (!queue?.length) return;
    const next = queue.shift();
    if (!queue.length) pendingManualTriggers.delete(chatId);
    const automation = store.getAutomation(next.automationId, next.userId);
    if (!automation) {
      store.updateAutomationRun(next.runId, { status: 'failed', finishedAt: Date.now(), error: 'Automation no longer exists.' });
      queueMicrotask(() => drainManualTriggers(chatId));
      return;
    }
    if (!launchAutomationRun(automation, next.runId)) {
      const remaining = pendingManualTriggers.get(chatId) || [];
      remaining.unshift(next);
      pendingManualTriggers.set(chatId, remaining);
      return;
    }
    if (queue.length) pendingManualTriggers.set(chatId, queue);
  };

  let scheduleTimer = null;
  let schedulerStopped = false;
  const refreshSchedules = () => {
    const now = Date.now();
    for (const automation of store.listAllAutomations()) {
      if (!automation.enabled) continue;
      // Recompute stale timestamps on startup or after changes without replaying
      // occurrences missed while the process was down.
      if (!automation.nextRunAt || automation.nextRunAt <= now) {
        try { store.updateAutomation(automation.id, { nextRunAt: nextSchedule(automation.cron, automation.timezone, now) }, automation.userId); }
        catch (err) { store.updateAutomation(automation.id, { enabled: false, lastStatus: `invalid schedule: ${err.message}` }, automation.userId); }
      }
    }
  };
  const processDue = () => {
    if (schedulerStopped) return;
    const now = Date.now();
    for (const automation of store.dueAutomations(now)) {
      const scheduledAt = automation.nextRunAt;
      const runId = store.addAutomationRun(automation.id, scheduledAt, 'queued');
      let nextRunAt;
      try { nextRunAt = nextSchedule(automation.cron, automation.timezone, scheduledAt); }
      catch (err) {
        store.updateAutomation(automation.id, { enabled: false, lastStatus: `invalid schedule: ${err.message}`, nextRunAt: null }, automation.userId);
        store.updateAutomationRun(runId, { status: 'failed', finishedAt: now, error: err.message });
        continue;
      }
      store.updateAutomation(automation.id, { nextRunAt }, automation.userId);
      if (isRunning(automation.chatId)) {
        store.updateAutomationRun(runId, { status: 'skipped', finishedAt: now, error: 'Target chat was already running.' });
        continue;
      }
      launchAutomationRun(automation, runId);
    }
    armScheduler();
  };
  armScheduler = () => {
    if (schedulerStopped) return;
    if (scheduleTimer) clearTimeout(scheduleTimer);
    refreshSchedules();
    const next = store.db.prepare('SELECT MIN(next_run_at) AS due FROM automations WHERE enabled=1').get()?.due;
    if (next == null) { scheduleTimer = null; return; }
    scheduleTimer = setTimeout(processDue, Math.max(25, Math.min(2_147_000_000, next - Date.now())));
    scheduleTimer.unref?.();
  };
  store.recoverAutomationRuns();

  /** Points one response at a run: the backlog from `from`, then the live rest. */
  function attach(run, res, from) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    });
    for (const ev of run.events.slice(from)) res.write(`data: ${JSON.stringify(ev)}\n\n`);
    if (run.done) return res.end();
    run.subs.add(res);
    // A viewer leaving is just a viewer leaving. The run keeps going.
    res.on('close', () => run.subs.delete(res));
    return undefined;
  }

  // Reachable without a session: the login/OAuth dance itself, plus static
  // assets so the login page can load before there's anyone to authenticate.
  const PRE_AUTH_PATHS = /^\/api\/auth\//;
  function isPreAuthPath(pathname) {
    return PRE_AUTH_PATHS.test(pathname) || !pathname.startsWith('/api/');
  }

  // In trusted-header mode the gateway owns login and logout; these two are
  // the only /api/auth routes that exist, and both need the resolved user.
  const TRUSTED_AUTH_PATHS = new Set(['/api/auth/me', '/api/auth/logout']);
  // Still answered for a pending/disabled user, so the UI can say why.
  const STATUS_EXEMPT_PATHS = TRUSTED_AUTH_PATHS;

  /**
   * The one auth gate for the whole handler. Fails closed: with auth on, a
   * request either resolves to a real user or carries `userId: undefined`,
   * which every scoped store method refuses. 'none' is a single-person
   * install and sees everything, exactly as before auth existed.
   */
  function resolveAuth(req) {
    const auth = resolveIdentity(req);
    // Features come from the policy for the caller's role; nobody signed in
    // gets none, which leaves only the routes the table marks open.
    auth.features = auth.userId !== undefined ? featuresFor(cfg, auth.role) : new Set();
    if (cfg.authMode === 'trusted-header' && auth.user) auth.isAdmin = auth.features.has('admin');
    return auth;
  }

  function resolveIdentity(req) {
    if (cfg.authMode === 'none') return { userId: ALL_USERS, role: null, user: null, isAdmin: true };
    const pathname = (req.url || '').split('?')[0];
    let user;
    if (cfg.authMode === 'trusted-header') {
      if (!pathname.startsWith('/api/')) return { userId: undefined, user: null, isAdmin: false };
      if (pathname.startsWith('/api/auth/') && !TRUSTED_AUTH_PATHS.has(pathname)) return { notFound: true };
      const result = resolveTrustedUser(req, store, cfg);
      if (result.reject) {
        audit('auth.rejected', { reason: result.reject, path: pathname });
        return { unauthorized: true };
      }
      user = result.user;
    } else {
      user = getSessionUser(req, store, cfg);
      if (!user) {
        if (!isPreAuthPath(pathname)) return { unauthorized: true };
        return { userId: undefined, user: null, isAdmin: false };
      }
    }
    if (!STATUS_EXEMPT_PATHS.has(pathname) && !(cfg.authMode !== 'trusted-header' && isPreAuthPath(pathname))) {
      if (user.status === 'disabled') return { disabled: true };
      if (user.status !== 'approved') return { pending: true };
    }
    if (cfg.authMode === 'single') return { userId: ALL_USERS, role: 'admin', user, isAdmin: true };
    return { userId: user.id, role: user.role, user, isAdmin: user.role === 'admin' && user.status === 'approved' };
  }

  // The user-management and oversight routes only mean something when there
  // is more than one person; 'none' and 'single' are just you.
  const multiUser = () => cfg.authMode === 'trusted-header';

  // Fields a non-admin never sees: credentials, and where the deployment's
  // trust boundary sits.
  const ADMIN_ONLY_FIELDS = /^(apiKey|authPassword|sessionSecret|google|baseUrl|trusted|adminEmails|models$)/;
  function configFor(auth) {
    const pub = publicConfig(cfg);
    if (auth.features.has('settings')) return pub;
    const out = {};
    for (const [k, v] of Object.entries(pub)) if (!ADMIN_ONLY_FIELDS.test(k)) out[k] = v;
    return { ...out, readOnly: true };
  }

  const server = createServer(async (req, res) => {
    try {
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
      if (crossSite(req, cfg)) {
        audit('request.cross_site_rejected', { method: req.method, path: (req.url || '').split('?')[0] });
        return json(res, 403, { error: 'cross-site request refused' });
      }
      // Probes for orchestrators: no auth, nothing sensitive. /healthz says
      // the process answers; /readyz that it can serve (database reachable),
      // and which build and config it serves.
      const probe = (req.url || '').split('?')[0];
      if (req.method === 'GET' && probe === '/healthz') return json(res, 200, { ok: true });
      if (req.method === 'GET' && probe === '/readyz') {
        let dbOk = false;
        try { dbOk = store.ping(); } catch { /* not ready */ }
        return json(res, dbOk ? 200 : 503, { ready: dbOk, version: VERSION, fingerprint: fingerprint(cfg, source.loadMcpServers()) });
      }
      const auth = resolveAuth(req);
      if (auth.notFound) return json(res, 404, { error: 'not found' });
      if (auth.unauthorized) return json(res, 401, { error: 'unauthorized' });
      if (auth.disabled) return json(res, 403, { error: 'disabled' });
      if (auth.pending) return json(res, 403, { error: 'pending_approval' });
      const adminOnly = () => json(res, 403, { error: 'admin_only' });

      // Every API route is listed in ROUTES with the feature it needs. A
      // route missing from the table is unreachable, so a new route cannot
      // ship without a decision about who may use it.
      const pathname = (req.url || '').split('?')[0];
      if (pathname.startsWith('/api/')) {
        const route = ROUTES.find(([m, re]) => (m === '*' || m === req.method) && re.test(pathname));
        if (!route) return json(res, 404, { error: 'not found' });
        const feature = route[2];
        if (feature && !auth.features.has(feature)) return json(res, 403, { error: 'feature_disabled', feature });
      }

      if (req.method === 'GET' && req.url === '/api/auth/me') {
        return json(res, 200, {
          authMode: cfg.authMode,
          logoutUrl: cfg.logoutUrl || '',
          isAdmin: Boolean(auth.isAdmin),
          features: [...auth.features],
          models: auth.userId !== undefined ? modelsFor(cfg, auth.role) : [],
          model: auth.userId !== undefined ? modelFor(auth.user?.id, auth.role) : null,
          modelLabel: auth.userId !== undefined ? labelFor(cfg, modelFor(auth.user?.id, auth.role)) : null,
          user: auth.user
            ? { id: auth.user.id, email: auth.user.email, name: auth.user.name ?? null, role: auth.user.role, status: auth.user.status }
            : null
        });
      }

      // Tier 3's model pill: a personal choice among the role's models. In
      // tiers 1-2 the pill changes the configured model instead (/api/config).
      if (req.method === 'POST' && req.url === '/api/me/prefs') {
        if (!multiUser()) return json(res, 400, { error: 'preferences are per-user; set the model in settings' });
        const { model } = await readJson(req);
        if (model !== null && (typeof model !== 'string' || !model.trim())) return json(res, 400, { error: 'model must be a model id or null' });
        const allowed = modelsFor(cfg, auth.role);
        if (model && isClosed(cfg) && !findEntry(cfg, model)) return json(res, 403, { error: 'that model is not available to you' });
        if (model && allowed !== '*' && !allowed.includes(model)) return json(res, 403, { error: 'that model is not available to you' });
        store.setPref(auth.user.id, 'model', model ? model.trim() : null);
        return json(res, 200, { model: modelFor(auth.user.id, auth.role) });
      }

      if (req.method === 'POST' && req.url === '/api/auth/logout' && cfg.authMode === 'trusted-header') {
        return json(res, 200, { redirect: cfg.logoutUrl || null });
      }

      if (cfg.authMode === 'single' && req.method === 'POST' && req.url === '/api/auth/login') {
        const who = req.socket.remoteAddress || '?';
        const now = Date.now();
        const f = loginFailures.get(who);
        if (f && now - f.first > LOGIN_WINDOW_MS) loginFailures.delete(who);
        const entry = loginFailures.get(who);
        if (entry && entry.count >= LOGIN_MAX) {
          return json(res, 429, { error: 'too many attempts, try again later' });
        }
        const { password } = await readJson(req);
        if (!verifyPassword(password, passwordHash)) {
          loginFailures.set(who, { first: entry?.first ?? now, count: (entry?.count ?? 0) + 1 });
          audit('auth.rejected', { reason: 'bad_password' });
          return json(res, 401, { error: 'wrong password' });
        }
        loginFailures.delete(who);
        const token = createSession(store, OWNER_ID, cfg.sessionTtlDays);
        audit('auth.login', { userId: OWNER_ID });
        res.setHeader('set-cookie', sessionCookie(token, cfg.sessionSecret, { secure: isSecureRequest(req, cfg.trustedProxyCidrs) }));
        return json(res, 200, { ok: true });
      }

      if (cfg.authMode === 'single' && req.method === 'POST' && req.url === '/api/auth/logout') {
        const token = sessionToken(req, cfg);
        if (token) destroySession(store, token);
        res.setHeader('set-cookie', clearCookie({ secure: isSecureRequest(req, cfg.trustedProxyCidrs) }));
        return json(res, 200, { ok: true });
      }

      if (req.url === '/api/admin/users' && req.method === 'GET') {
        if (!multiUser()) return adminOnly();
        const pins = resolveAccess(cfg);
        const code = source.codeAccessUsers();
        const pinnedBy = (u) => (pins.bootstrapAdmins.includes(u.external_id) ? 'bootstrapAdmins'
          : code[u.external_id] ? 'access.users' : null);
        return json(res, 200, {
          fingerprint: fingerprint(cfg, source.loadMcpServers()),
          users: store.listUsers().map((u) => ({ ...adminUserView(u), pinnedInCode: pinnedBy(u) }))
        });
      }

      const adminUser = /^\/api\/admin\/users\/([\w-]+)$/.exec(req.url || '');
      if (adminUser && req.method === 'PATCH') {
        if (!multiUser()) return adminOnly();
        const target = store.getUser(adminUser[1]);
        if (!target) return json(res, 404, { error: 'no such user' });
        const { role, status } = await readJson(req);
        if (role !== undefined && !['admin', 'user'].includes(role)) return json(res, 400, { error: 'role must be admin or user' });
        if (status !== undefined && !['pending', 'approved', 'disabled'].includes(status)) {
          return json(res, 400, { error: 'status must be pending, approved or disabled' });
        }
        if (target.id === auth.userId && ((role && role !== 'admin') || (status && status !== 'approved'))) {
          return json(res, 400, { error: 'you cannot demote or disable your own account' });
        }
        const pins = resolveAccess(cfg);
        if (target.external_id && pins.bootstrapAdmins.includes(target.external_id)) {
          return json(res, 400, { error: 'this admin is declared in code (access.bootstrapAdmins)' });
        }
        // The file is the record: the decision goes into config.json's
        // access.users first, and only then into the database.
        if (target.external_id) {
          const file = source.readFile();
          const access = file.access && typeof file.access === 'object' ? file.access : {};
          const users = { ...(access.users || {}) };
          users[target.external_id] = {
            ...(users[target.external_id] || {}),
            ...(role !== undefined ? { role } : {}),
            ...(status !== undefined ? { status } : {})
          };
          const merged = { ...file, access: { ...access, users } };
          const problems = validateConfig({ ...cfg, access: merged.access });
          if (problems.length) return json(res, 400, { error: problems.join('; ') });
          const code = source.codeAccessUsers();
          if (code[target.external_id]) return json(res, 409, { error: 'this user is pinned in code (access.users)' });
          source.writeFile(merged);
          cfg = source.load();
        }
        const updated = store.updateUser(target.id, { role, status });
        if (role !== undefined && role !== target.role) {
          audit('user.role_changed', { userId: target.id, from: target.role, to: role, by: auth.userId });
        }
        if (status !== undefined && status !== target.status) {
          audit('user.status_changed', { userId: target.id, from: target.status, to: status, by: auth.userId });
          if (status !== 'approved') destroyUserSessions(store, target.id);
        }
        return json(res, 200, { user: adminUserView(updated) });
      }

      // Admin oversight: read-only, every view audited. Reached through
      // ALL_USERS on purpose -- this is the one place a user's scope is
      // crossed, and it only exists when there are users to cross between.
      const adminChats = /^\/api\/admin\/users\/([\w-]+)\/chats$/.exec(req.url || '');
      const adminChat = /^\/api\/admin\/chats\/([\w.-]+)$/.exec(req.url || '');
      const adminDoc = /^\/api\/admin\/documents\/([\w.-]+)$/.exec(req.url || '');
      if ((adminChats || adminChat || adminDoc) && req.method === 'GET') {
        if (!multiUser()) return adminOnly();
        if (adminChats) {
          const target = store.getUser(adminChats[1]);
          if (!target) return json(res, 404, { error: 'no such user' });
          audit('admin.view_user_chats', { by: auth.userId, userId: target.id });
          const chats = store.listChats(500, target.id).map((c) => ({ ...c, running: isRunning(c.id) }));
          const stats = store.usageStatistics(target.id);
          return json(res, 200, { user: adminUserView(target), chats, summary: stats.summary });
        }
        if (adminChat) {
          const found = store.getChat(adminChat[1], ALL_USERS);
          if (!found) return json(res, 404, { error: 'no such chat' });
          audit('admin.view_chat', { by: auth.userId, chatId: found.id, owner: found.user_id });
          const owner = found.user_id ? store.getUser(found.user_id) : null;
          return json(res, 200, {
            id: found.id, title: found.title, updatedAt: found.updated_at,
            owner: owner ? adminUserView(owner) : null,
            running: isRunning(found.id),
            messages: store.messages(found.id).map(toView),
            documents: store.listDocuments(found.id)
          });
        }
        const doc = store.getDocument(adminDoc[1], ALL_USERS);
        if (!doc) return json(res, 404, { error: 'no such document' });
        audit('admin.view_document', { by: auth.userId, documentId: doc.id, chatId: doc.chat_id });
        return json(res, 200, { filename: doc.filename, mime: doc.mime, content: doc.content });
      }

      // Non-secret facts about this deployment, for scripts verifying what is
      // running: build, config hash, database schema, auth, MCP server names.
      if (req.method === 'GET' && req.url === '/api/meta') {
        return json(res, 200, {
          version: VERSION,
          schemaVersion: store.schemaVersion(),
          fingerprint: fingerprint(cfg, source.loadMcpServers()),
          configMode: source.isFrozen() ? 'frozen' : 'editable',
          authMode: cfg.authMode,
          mcpServers: Object.keys(source.loadMcpServers()).sort()
        });
      }

      if (req.method === 'GET' && req.url === '/api/config') {
        return json(res, 200, {
          ...configFor(auth),
          tools: hub.tools.map((t) => ({
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters
          })),
          mcpErrors: hub.errors
        });
      }

      if (req.method === 'POST' && req.url === '/api/config') {
        cfg = saveConfig(await readJson(req), actor(auth));
        audit('admin.config_changed', { by: auth.userId ?? null });
        return json(res, 200, configFor(auth));
      }

      // The provider's own model list, for the composer's model picker. Not
      // every OpenAI-compatible endpoint serves /models, so a failure is an
      // answer too: the picker falls back to typing an id.
      if (req.method === 'GET' && req.url === '/api/models') {
        const allowed = modelsFor(cfg, auth.role);
        // A catalog is the whole list: its labels, never the provider's ids.
        if (isClosed(cfg)) {
          const entries = enabledEntries(cfg).filter((e) => allowed === '*' || allowed.includes(e.id));
          return json(res, 200, { supported: true, restricted: true, catalog: true, models: entries.map(publicEntry) });
        }
        const all = await listModels();
        if (allowed === '*') return json(res, 200, all);
        // A fixed catalog: only those ids, named from the provider list when
        // it knows them, listed even when it does not.
        const byId = new Map(all.models.map((m) => [m.id, m]));
        return json(res, 200, { supported: true, restricted: true, models: allowed.map((id) => byId.get(id) || { id, name: null }) });
      }

      // The grouped view behind the tools panel: built-ins, and every MCP
      // server's tools under it with that server's connection health.
      if (req.method === 'GET' && req.url === '/api/tools') {
        return json(res, 200, toolsView());
      }

      // Per-tool approval override from the settings panel: 'ask', 'auto', or
      // 'default' to fall back to the global toolApproval mode.
      if (req.method === 'POST' && req.url === '/api/tools/approval') {
        const { name, policy } = await readJson(req);
        if (!name || !['ask', 'auto', 'default'].includes(policy)) {
          return json(res, 400, { error: 'name and policy (ask | auto | default) are required' });
        }
        cfg = saveConfig(setOverride(cfg, name, policy), actor(auth));
        return json(res, 200, toolsView());
      }

      if (req.method === 'POST' && req.url === '/api/tools/toggle') {
        const { name, disabled } = await readJson(req);
        if (!name) return json(res, 400, { error: 'name is required' });
        const set = new Set(cfg.disabledTools || []);
        if (disabled) set.add(name); else set.delete(name);
        cfg = saveConfig({ disabledTools: [...set] }, actor(auth));
        return json(res, 200, toolsView());
      }

      if (req.method === 'GET' && req.url === '/api/mcp') {
        // mcp.json can hold server credentials (env, headers): admins only.
        return json(res, 200, { path: source.mcpPath(), text: readMcpFile(), locked: source.mcpLocked });
      }

      // Disabling a server tears its connection down rather than filtering its
      // tools out client-side: an unwanted server is one fewer child process or
      // open connection, not just one the model happens not to be offered.
      const serverToggle = /^\/api\/mcp\/servers\/([^/]+)\/toggle$/.exec(req.url || '');
      if (serverToggle && req.method === 'POST') {
        const name = decodeURIComponent(serverToggle[1]);
        const { disabled } = await readJson(req);
        let servers;
        try {
          const parsed = JSON.parse(readMcpFile());
          servers = parsed.mcpServers || parsed;
        } catch (err) {
          return json(res, 500, { error: `mcp.json is not valid JSON: ${err.message}` });
        }
        if (!servers[name]) return json(res, 404, { error: `no such server "${name}"` });
        servers[name] = { ...servers[name], disabled: Boolean(disabled) };

        let updated;
        try {
          const before = fingerprint(cfg, source.loadMcpServers());
          updated = saveMcpFile(JSON.stringify({ mcpServers: servers }, null, 2));
          auditMcp(actor(auth), before);
        } catch (err) {
          return json(res, err instanceof LockedError ? 409 : 400, { error: err.message });
        }
        const old = hub;
        hub = await connectHub(updated);
        mcpText = readMcpFile();
        await old.close();
        console.log(`[tinywebui] mcp reloaded: ${hub.tools.length} tool(s)`);
        return json(res, 200, { ...hub.inventory(cfg.disabledTools), disabledTools: cfg.disabledTools || [] });
      }

      if (req.method === 'POST' && req.url === '/api/mcp') {
        const { text } = await readJson(req, UPLOAD_LIMIT);
        let servers;
        try {
          const before = fingerprint(cfg, source.loadMcpServers());
          servers = saveMcpFile(text);
          auditMcp(actor(auth), before);
        } catch (err) {
          return json(res, err instanceof LockedError ? 409 : 400, { error: err.message });
        }
        // Swap the hub wholesale: old child processes are shut down before the
        // new ones start, so a rename cannot leave an orphan behind.
        const old = hub;
        hub = await connectHub(servers);
        mcpText = readMcpFile();
        await old.close();
        console.log(`[tinywebui] mcp reloaded: ${hub.tools.length} tool(s)`);
        return json(res, 200, {
          tools: hub.tools.map((t) => ({
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters
          })),
          mcpErrors: hub.errors
        });
      }

      // Full-text search across every stored message, for the sidebar's search
      // box. GET with a query string, so it is bookmarkable and cacheable like
      // any other read, unlike the POST-with-body routes below it.
      if (req.method === 'GET' && (req.url || '').split('?')[0] === '/api/search') {
        const q = new URL(req.url, 'http://x').searchParams.get('q') || '';
        const limit = 30;
        // A chat mid-turn is still being written -- store.search would be
        // matching against text that has not settled, and openChat/rejoin is
        // not built to land a click in the middle of a live stream. Overfetch
        // and filter rather than ask the store to know about runs, which is a
        // server-only concept it has no business importing.
        const results = store.search(q, limit * 2, auth.userId)
          .filter((r) => !isRunning(r.chatId))
          .slice(0, limit);
        return json(res, 200, { results });
      }

      if (req.method === 'GET' && (req.url || '').split('?')[0] === '/api/usage') {
        return json(res, 200, { days: store.usageRollup(auth.userId), statistics: store.usageStatistics(auth.userId) });
      }

      if (req.method === 'GET' && req.url === '/api/folders') {
        return json(res, 200, { folders: store.listFolders(auth.userId) });
      }

      if (req.method === 'POST' && req.url === '/api/folders') {
        const { name } = await readJson(req);
        const created = store.createFolder(name, auth.userId);
        if (!created) return json(res, 400, { error: 'folder name required' });
        return json(res, 200, { folder: created });
      }

      if (req.method === 'GET' && req.url === '/api/automations') {
        return json(res, 200, { automations: store.listAutomations(auth.userId), chats: store.listChats(200, auth.userId) });
      }
      if (req.method === 'POST' && req.url === '/api/automations') {
        const body = await readJson(req);
        const newChatTitle = newChatTitleOf(body);
        if (newChatTitle === false) return json(res, 400, { error: 'the new chat needs a name (at most 120 characters)' });
        let chat = newChatTitle ? null : store.getChat(String(body.chatId || ''), auth.userId);
        if (!newChatTitle && !chat) return json(res, 400, { error: 'a chat you own is required' });
        const name = String(body.name || '').trim();
        const prompt = String(body.prompt || '').trim();
        if (!name || !prompt) return json(res, 400, { error: 'name and prompt are required' });
        if (name.length > 120 || prompt.length > 12000) return json(res, 400, { error: 'name or prompt is too long' });
        let schedule;
        try { schedule = validateSchedule(body.cron, body.timezone); }
        catch (err) { return json(res, 400, { error: err.message }); }
        if (newChatTitle) chat = store.createChat({ title: newChatTitle }, auth.userId);
        const automation = store.createAutomation({ ...schedule, chatId: chat.id, name, prompt, enabled: body.enabled !== false, source: 'user' }, auth.userId);
        armScheduler();
        return json(res, 201, { automation });
      }
      const automationRoute = /^\/api\/automations\/([\w.-]+)(?:\/(runs|trigger))?$/.exec((req.url || '').split('?')[0]);
      if (automationRoute && automationRoute[2] === 'runs' && req.method === 'GET') {
        const runs = store.listAutomationRuns(automationRoute[1], auth.userId);
        return runs ? json(res, 200, { runs }) : json(res, 404, { error: 'no such automation' });
      }
      if (automationRoute && automationRoute[2] === 'trigger' && req.method === 'POST') {
        const automation = store.getAutomation(automationRoute[1], auth.userId);
        if (!automation) return json(res, 404, { error: 'no such automation' });
        const run = await triggerAutomation(automation, auth.userId);
        return json(res, 202, { run });
      }
      if (automationRoute && !automationRoute[2] && req.method === 'PATCH') {
        const existing = store.getAutomation(automationRoute[1], auth.userId);
        if (!existing) return json(res, 404, { error: 'no such automation' });
        const body = await readJson(req);
        const patch = {};
        for (const key of ['name', 'prompt', 'cron', 'timezone', 'enabled', 'chatId']) if (body[key] !== undefined) patch[key] = body[key];
        const newChatTitle = newChatTitleOf(body);
        if (newChatTitle === false) return json(res, 400, { error: 'the new chat needs a name (at most 120 characters)' });
        if (newChatTitle) delete patch.chatId;
        if (patch.chatId !== undefined) {
          const chat = store.getChat(String(patch.chatId), auth.userId);
          if (!chat) return json(res, 400, { error: 'a chat you own is required' });
          patch.chatId = chat.id;
        }
        if (patch.name !== undefined) { patch.name = String(patch.name).trim(); if (!patch.name || patch.name.length > 120) return json(res, 400, { error: 'name is required and must be at most 120 characters' }); }
        if (patch.prompt !== undefined) { patch.prompt = String(patch.prompt).trim(); if (!patch.prompt || patch.prompt.length > 12000) return json(res, 400, { error: 'prompt is required and must be at most 12000 characters' }); }
        if (patch.cron !== undefined || patch.timezone !== undefined) {
          let schedule;
          try { schedule = validateSchedule(patch.cron ?? existing.cron, patch.timezone ?? existing.timezone); }
          catch (err) { return json(res, 400, { error: err.message }); }
          Object.assign(patch, schedule);
        }
        if (newChatTitle) patch.chatId = store.createChat({ title: newChatTitle }, auth.userId).id;
        const automation = store.updateAutomation(automationRoute[1], patch, auth.userId);
        armScheduler();
        return json(res, 200, { automation });
      }
      if (automationRoute && !automationRoute[2] && req.method === 'DELETE') {
        if (!store.deleteAutomation(automationRoute[1], auth.userId)) return json(res, 404, { error: 'no such automation' });
        armScheduler();
        return json(res, 200, { ok: true });
      }

      if (req.method === 'GET' && req.url === '/api/chats') {
        // `running` is what puts the dot in the sidebar: a turn belongs to the
        // server, so a chat can be working while nothing is watching it.
        const list = store.listChats(200, auth.userId).map((c) => ({ ...c, running: isRunning(c.id) }));
        return json(res, 200, { chats: list });
      }

      const organize = /^\/api\/chats\/([\w.-]+)\/organize$/.exec(req.url || '');
      if (organize && req.method === 'POST') {
        const { folder, tags } = await readJson(req);
        const found = store.getChat(organize[1], auth.userId);
        if (!found) return json(res, 404, { error: 'no such chat' });
        if (folder) store.createFolder(folder, auth.userId);
        const updated = store.organizeChat(organize[1], { folder, tags }, auth.userId);
        return json(res, 200, { folder: updated.folder });
      }

      const one = /^\/api\/chats\/([\w.-]+)$/.exec(req.url || '');
      if (one && req.method === 'GET') {
        const found = store.getChat(one[1], auth.userId);
        if (!found) return json(res, 404, { error: 'no such chat' });
        const run = runs.get(found.id);
        const live = run && !run.done;
        const messages = store.messages(found.id).map(toView);
        return json(res, 200, {
          id: found.id,
          title: found.title,
          folder: found.folder || null,
          epoch: found.epoch,
          // A turn in flight has already written some of itself to the store.
          // Cutting the transcript back to where the turn began lets the client
          // replay the settled part and then play the run's events over the top,
          // instead of rendering the same rounds twice.
          messages: live ? messages.slice(0, run.baseCount) : messages,
          running: Boolean(live),
          queued: store.listQueued(found.id),
          tasks: store.listTasks(found.id),
          documents: store.listDocuments(found.id)
        });
      }

      // Uploads (including the paste-as-file path) land here before the first
      // message exists, so the chat is created lazily, the same way /api/chat
      // creates one for a brand-new conversation.
      const uploadDoc = /^\/api\/chats\/([\w.-]+)\/documents$/.exec(req.url || '');
      if (uploadDoc && req.method === 'POST') {
        const [, chatId] = uploadDoc;
        const { filename, mime, dataBase64 } = await readJson(req, UPLOAD_LIMIT);
        if (!filename || typeof dataBase64 !== 'string') {
          return json(res, 400, { error: 'filename and dataBase64 are required' });
        }
        let buf;
        try {
          buf = Buffer.from(dataBase64, 'base64');
        } catch {
          return json(res, 400, { error: 'dataBase64 is not valid base64' });
        }
        const MAX_BYTES = 5 * 1024 * 1024;
        if (buf.length > MAX_BYTES) {
          return json(res, 400, { error: `file exceeds ${MAX_BYTES.toLocaleString('en-US')} byte limit` });
        }

        let text;
        try {
          text = await extractText(buf, String(filename));
        } catch (err) {
          return json(res, 400, { error: err.message });
        }
        if (!text.trim()) return json(res, 400, { error: 'no extractable text in that file' });

        if (!store.getChat(chatId, auth.userId) && store.chatById(chatId)) return json(res, 404, { error: 'no such chat' });
        const chat = store.getChat(chatId, auth.userId) || store.createChat({ id: chatId, title: String(filename).slice(0, 60) }, auth.userId);
        const doc = store.addDocument(chat.id, { filename: String(filename), mime: mime || null, content: text }, retrieval.passageSettings());
        // Embedded once, in the background; a question that arrives first waits for it.
        retrieval.ingest(doc.id).catch((err) => console.error(`[tinywebui] embedding ${doc.id} failed: ${err.message}`));
        return json(res, 200, { chatId: chat.id, document: doc });
      }

      // Converts one staged image to a wire-safe format before it's ever sent,
      // so the composer's own preview and the optimistic thumbnail in the
      // transcript show the same bytes the model (and the store) end up with,
      // instead of a HEIC/AVIF the browser can't decode until the turn ends
      // and the chat reloads with what the server stored.
      if (req.method === 'POST' && req.url === '/api/images/normalize') {
        const { mime, dataBase64 } = await readJson(req, UPLOAD_LIMIT);
        const normalized = await normalizeUpload(mime, dataBase64);
        if (!normalized) return json(res, 400, { error: 'unrecognized or oversized image' });
        return json(res, 200, normalized);
      }

      // Lets the "files" rail open a document's full extracted text -- the
      // same content the model reads via read_document, in a plain new tab.
      const docContent = /^\/api\/documents\/([\w.-]+)$/.exec(req.url || '');
      if (docContent && req.method === 'GET') {
        const doc = store.getDocument(docContent[1], auth.userId);
        if (!doc) return json(res, 404, { error: 'no such document' });
        return json(res, 200, { filename: doc.filename, mime: doc.mime, content: doc.content });
      }
      // Artifacts have no delete route of their own: the rail is a record of
      // what the conversation actually used, and the only way one goes away
      // is editing the message that attached it and dropping it there -- see
      // /edit below, which is the only place store.deleteDocument is called.

      const stream = /^\/api\/chats\/([\w.-]+)\/stream$/.exec((req.url || '').split('?')[0]);
      if (stream && req.method === 'GET') {
        if (!store.getChat(stream[1], auth.userId)) return json(res, 404, { error: 'no such chat' });
        const run = runs.get(stream[1]);
        if (!run) return json(res, 404, { error: 'nothing running' });
        const from = Number(new URL(req.url, 'http://x').searchParams.get('from')) || 0;
        return attach(run, res, from);
      }

      // Rewriting a question and answering it again. Asking the same question
      // again is the same operation with the same text, so there is one route.
      const rewind = /^\/api\/chats\/([\w.-]+)\/edit$/.exec(req.url || '');
      if (rewind && req.method === 'POST') {
        const [, id] = rewind;
        const found = store.getChat(id, auth.userId);
        if (!found) return json(res, 404, { error: 'no such chat' });
        // Rewriting history under a turn that is still reading it would leave
        // the run answering a question that no longer exists.
        if (isRunning(id)) return json(res, 409, { error: 'that chat is still working; stop it first' });

        const { seq, message, documentIds, removeDocumentIds, images } = await readJson(req, TURN_LIMIT);
        if (Array.isArray(images) && images.length && !auth.features.has('images')) return json(res, 403, { error: 'feature_disabled', feature: 'images' });
        if (Array.isArray(documentIds) && documentIds.length && !auth.features.has('attachments')) return json(res, 403, { error: 'feature_disabled', feature: 'attachments' });
        const text = String(message ?? '').trim();
        if (!text) return json(res, 400, { error: 'message is required' });
        const target = store.messages(id).find((m) => m.seq === Number(seq));
        if (!target || target.role !== 'user') {
          return json(res, 400, { error: 'seq must name a question of your own' });
        }

        store.truncateFrom(id, Number(seq));
        // A document is chat-scoped, not part of the message row that just got
        // truncated, so dropping one during edit takes an explicit delete --
        // this is the only place that happens. Nothing survives that would
        // still reference it: truncateFrom already took every later message
        // (the only other place a reference could live) with it.
        for (const docId of Array.isArray(removeDocumentIds) ? removeDocumentIds : []) {
          const doc = store.getDocument(docId, auth.userId);
          if (doc?.chat_id === id) store.deleteDocument(docId, auth.userId);
        }
        let content = text;
        for (const docId of Array.isArray(documentIds) ? documentIds : []) {
          const doc = store.getDocument(docId, auth.userId);
          if (doc?.chat_id === id) content += attachmentNote(doc);
        }
        const kept = Array.isArray(images) ? images.filter((img) => img?.mime && img?.data) : [];
        store.addMessage(id, { role: 'user', content, ...(kept.length ? { images: kept } : {}) });

        // The run is started but not streamed back here. The client reloads the
        // rewound transcript and then attaches, the same path a reload takes,
        // rather than reading a stream through a response it also has to
        // redraw behind.
        startRun({ chat: found, tools: toolsFor(auth.features), model: modelFor(auth.user?.id, auth.role) });
        return json(res, 200, { ok: true, running: true });
      }

      // The user's answer to an approval prompt in the transcript.
      const approval = /^\/api\/chats\/([\w.-]+)\/approve$/.exec(req.url || '');
      if (approval && req.method === 'POST') {
        if (!store.getChat(approval[1], auth.userId)) return json(res, 404, { error: 'no such chat' });
        const { id, decision } = await readJson(req);
        if (!['allow', 'always', 'deny'].includes(decision)) {
          return json(res, 400, { error: 'decision must be allow, always or deny' });
        }
        const run = runs.get(approval[1]);
        const pending = run?.approvals.get(id);
        if (!pending) return json(res, 409, { error: 'that call is no longer waiting' });
        run.approvals.delete(id);
        // "Always" rewrites tool policy, which is the tools feature's to do;
        // without it, the answer counts as allowing this one call.
        if (decision === 'always' && auth.features.has('tools')) {
          // Approval lists set in code cannot be saved to; allow this call only.
          try { cfg = saveConfig(setOverride(cfg, pending.name, 'auto'), actor(auth)); }
          catch (err) { if (!(err instanceof LockedError)) throw err; }
        }
        pending.resolve(decision);
        return json(res, 200, { ok: true });
      }

      // The user's answer to an ask_user question, or `skip` to let the run
      // continue without one. Only the run's own open question can be
      // answered; anything else (answered, timed out, stopped) is a 409.
      const answerRoute = /^\/api\/chats\/([\w.-]+)\/answer$/.exec(req.url || '');
      if (answerRoute && req.method === 'POST') {
        if (!store.getChat(answerRoute[1], auth.userId)) return json(res, 404, { error: 'no such chat' });
        const { id, answer, skip } = await readJson(req, TURN_LIMIT);
        const pending = runs.get(answerRoute[1])?.question;
        if (!pending || pending.id !== id) return json(res, 409, { error: 'that question is no longer waiting' });
        if (skip === true) {
          return pending.settle('skipped') ? json(res, 200, { ok: true }) : json(res, 409, { error: 'that question is no longer waiting' });
        }
        const text = String(answer ?? '').trim();
        if (!text) return json(res, 400, { error: 'answer is required' });
        if (!pending.allowFreeText && !pending.choices.includes(text)) {
          return json(res, 400, { error: 'answer must be one of the offered choices' });
        }
        return pending.settle('answered', text) ? json(res, 200, { ok: true }) : json(res, 409, { error: 'that question is no longer waiting' });
      }

      // Input sent while a turn is running. Refused when nothing interactive
      // is running (send it normally) and while an automation holds the chat.
      const queue = /^\/api\/chats\/([\w.-]+)\/queue(?:\/([\w.-]+))?$/.exec(req.url || '');
      if (queue && req.method === 'POST' && !queue[2]) {
        if (!store.getChat(queue[1], auth.userId)) return json(res, 404, { error: 'no such chat' });
        const { id, kind, message } = await readJson(req, TURN_LIMIT);
        const text = String(message ?? '').trim();
        if (!text) return json(res, 400, { error: 'message is required' });
        if (!['steer', 'followup'].includes(kind)) return json(res, 400, { error: 'kind must be steer or followup' });
        if (typeof id !== 'string' || !/^[\w.-]{1,64}$/.test(id)) return json(res, 400, { error: 'id is required' });
        const run = runs.get(queue[1]);
        if (!run || run.done) return json(res, 409, { error: 'nothing is running; send it as a message' });
        if (run.unattended) return json(res, 409, { error: 'an automation is running in this chat; wait for it to finish' });
        store.addQueued(queue[1], { id, kind, content: text });
        announceQueue(queue[1]);
        return json(res, 200, { ok: true, items: store.listQueued(queue[1]) });
      }
      if (queue && req.method === 'DELETE' && queue[2]) {
        if (!store.getChat(queue[1], auth.userId)) return json(res, 404, { error: 'no such chat' });
        const removed = store.deleteQueued(queue[1], queue[2]);
        announceQueue(queue[1]);
        return json(res, removed ? 200 : 409, removed ? { ok: true } : { error: 'already delivered' });
      }

      const stop = /^\/api\/chats\/([\w.-]+)\/stop$/.exec(req.url || '');
      if (stop && req.method === 'POST') {
        if (!store.getChat(stop[1], auth.userId)) return json(res, 404, { error: 'no such chat' });
        runs.get(stop[1])?.ac.abort();
        return json(res, 200, { ok: true });
      }
      if (one && req.method === 'DELETE') {
        if (!store.getChat(one[1], auth.userId)) return json(res, 404, { error: 'no such chat' });
        store.deleteChat(one[1], auth.userId);
        return json(res, 200, { ok: true });
      }

      // One-shot migration for transcripts still sitting in localStorage.
      // Imported tool results become artifacts like any other, so an old chat
      // is compactable the moment it is carried over.
      if (req.method === 'POST' && req.url === '/api/chats/import') {
        const { chats = [] } = await readJson(req, IMPORT_LIMIT);
        let imported = 0;
        for (const c of chats) {
          if (!c?.id || store.chatById(c.id)) continue;
          store.createChat({ id: c.id, title: c.title || 'Imported chat', createdAt: c.updated || Date.now() }, auth.userId);
          for (const m of c.messages || []) {
            const msg = { ...m };
            if (m.role === 'tool' && typeof m.content === 'string') {
              msg.artifact_id = store.addArtifact(c.id, {
                toolName: 'imported', args: {}, content: m.content
              });
            }
            store.addMessage(c.id, msg);
          }
          imported++;
        }
        return json(res, 200, { imported, chats: store.listChats(200, auth.userId) });
      }

      if (req.method === 'POST' && req.url === '/api/chat') {
        const { chatId, message, documentIds, images } = await readJson(req, TURN_LIMIT);
        if (Array.isArray(images) && images.length && !auth.features.has('images')) return json(res, 403, { error: 'feature_disabled', feature: 'images' });
        if (Array.isArray(documentIds) && documentIds.length && !auth.features.has('attachments')) return json(res, 403, { error: 'feature_disabled', feature: 'attachments' });
        if (!cfg.apiKey) return json(res, 400, { error: 'No API key. Set TINYWEBUI_API_KEY or apiKey in the config file.' });
        if (!message) return json(res, 400, { error: 'message is required' });

        // The client no longer ships the transcript: it sends the new turn and
        // the server replays what it already holds. That is what stops a
        // page-sized tool result from crossing the wire on every message.
        const owned = chatId && store.getChat(chatId, auth.userId);
        // Someone else's id is "no such chat", never a primary-key clash.
        if (chatId && !owned && store.chatById(chatId)) return json(res, 404, { error: 'no such chat' });
        const chat = owned || store.createChat({ id: chatId, title: String(message).slice(0, 60) }, auth.userId);

        // Attachments are surfaced as plain text inline notes rather than a
        // system-prompt change, the same idiom compact.js uses for a compacted
        // artifact -- the model sees "[Attached document: ...]" in the message
        // it's already reading and knows to call read_document on the id.
        let content = String(message);
        for (const id of Array.isArray(documentIds) ? documentIds : []) {
          const doc = store.getDocument(id, auth.userId);
          if (!doc || doc.chat_id !== chat.id) continue;
          content += attachmentNote(doc);
        }

        // Images ride directly on the message as OpenAI multimodal content
        // parts -- unlike a document there is no text to extract, so there is
        // nothing for the model to look up later; the bytes have to go up
        // with the turn that attached them. Capped on count and per-file size
        // the same way document uploads are, since these never touch disk on
        // their own path either.
        const MAX_IMAGES = 8;
        const imgs = [];
        for (const img of Array.isArray(images) ? images.slice(0, MAX_IMAGES) : []) {
          // Already normalized client-side in the common case (see
          // /api/images/normalize); re-normalizing is just a cheap passthrough
          // then, and a safety net for any caller that skipped that step.
          const normalized = await normalizeUpload(img?.mime, img?.dataBase64);
          if (normalized) imgs.push(normalized);
        }

        store.addMessage(chat.id, { role: 'user', content, ...(imgs.length ? { images: imgs } : {}) });

        // The turn is started, not awaited. Closing the tab detaches a
        // listener; it no longer kills the work, and the answer is in the store
        // whether or not anyone was watching when it landed.
        const existing = runs.get(chat.id);
        const run = existing && !existing.done
          ? existing
          : startRun({ chat, tools: toolsFor(auth.features), model: modelFor(auth.user?.id, auth.role) });
        return attach(run, res, 0);
      }

      return serveStatic(req, res);
    } catch (err) {
      if (err instanceof HttpError && err.status === 413) req.resume?.();
      if (!res.headersSent) json(res, err instanceof HttpError ? err.status : err instanceof LockedError ? 409 : 500, { error: err.message });
      else res.end();
    }
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  armScheduler();
  console.log(`[tinywebui] http://${host}:${port}`);
  // Documents stored before dense retrieval was on (or under another model)
  // are embedded in the background; queries on them fill in on demand too.
  retrieval.backfill((msg) => console.log(`[tinywebui] retrieval: ${msg}`))
    .catch((err) => console.error(`[tinywebui] retrieval backfill failed: ${err.message}`));

  // Real teardown, reused two ways: on SIGINT/SIGTERM it exits the process, and
  // as `server.shutdown()` it does not -- which is what a test harness needs,
  // since `process.kill(pid, 'SIGTERM')` is not something to lean on across
  // platforms and exiting the test runner's own process is not what a test
  // closing its server wants anyway.
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
      text = readMcpFile();
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
    if (next.authMode !== cfg.authMode) problems.push('authMode changes need a restart');
    if (JSON.stringify(next.retrieval) !== JSON.stringify(cfg.retrieval)) problems.push('retrieval changes need a restart');
    if (problems.length) {
      console.error(`[tinywebui] reload rejected (${reason}):\n  ${problems.join('\n  ')}`);
      audit('config.reload_rejected', { reason, problems });
      return false;
    }
    const before = fingerprint(cfg, serversOf(mcpText));
    const after = fingerprint(next, servers);
    const mcpChanged = text !== mcpText;
    if (before === after && !mcpChanged) return true; // our own write, or a no-op save
    cfg = next;
    if (cfg.authMode === 'single') passwordHash = cfg.authPassword || hashPassword(process.env.TINYWEBUI_PASSWORD);
    if (cfg.authMode === 'trusted-header') applyAccessPolicy(store, cfg);
    if (mcpChanged) {
      mcpText = text;
      const old = hub;
      hub = await connectHub(servers);
      await old.close();
    }
    armScheduler();
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

  const shutdown = async () => {
    schedulerStopped = true;
    clearTimeout(reloadTimer);
    for (const w of watchers) w.close();
    process.off('SIGHUP', onHup);
    if (scheduleTimer) clearTimeout(scheduleTimer);
    await hub.close();
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
