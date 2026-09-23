import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';

import {
  loadConfig, saveConfig, publicConfig, configPath,
  mcpPath, readMcpFile, saveMcpFile, loadMcpServers, dbPath
} from './config.js';
import { McpHub } from './mcp.js';
import { runChat } from './llm.js';
import { Store, toView } from './store.js';
import { getSessionUser } from './auth.js';
import { expandToolDef, callExpand } from './context_tool.js';
import { documentToolDef, callReadDocument } from './document_tool.js';
import { extractText } from './documents.js';
import { normalizeImage } from './images.js';
import { automationToolDef, manageAutomation, nextSchedule, runMessage, validateSchedule } from './automation.js';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** The inline note that tells the model an id it can read_document on. */
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

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
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

export async function start({ port = 7777, host = '127.0.0.1' } = {}) {
  let cfg = loadConfig();
  const store = new Store(dbPath(cfg));
  let armScheduler = () => {};
  let triggerAutomation = async () => { throw new Error('manual triggering is unavailable'); };
  let drainManualTriggers = () => {};
  const pendingManualTriggers = new Map();

  // context_expand is ours, not an MCP server's, but the model should not be
  // able to tell: it is registered onto the same hub and called the same way.
  const connectHub = async (servers) =>
    (await new McpHub(servers).connect())
      .registerLocal(expandToolDef(), (args, ctx) => callExpand(args, { ...ctx, store }))
      .registerLocal(documentToolDef(), (args, ctx) => callReadDocument(args, { ...ctx, store }))
      .registerLocal(automationToolDef(), (args, ctx) => {
        const out = manageAutomation(args, { ...ctx, store, triggerAutomation });
        armScheduler();
        return out;
      });

  let hub = await connectHub(loadMcpServers());

  console.log(`[tinywebui] config: ${configPath()}`);
  console.log(`[tinywebui] mcp:    ${mcpPath()}`);
  console.log(`[tinywebui] db:     ${dbPath(cfg)}`);
  console.log(`[tinywebui] model:  ${cfg.model} via ${cfg.baseUrl}`);
  console.log(`[tinywebui] tools:  ${hub.tools.length} from ${hub.clients.size} MCP server(s)`);
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

  function startRun({ chat, tools, onFinish, historyFromSeq = null }) {
    const run = {
      events: [],
      subs: new Set(),
      ac: new AbortController(),
      done: false,
      // Where the store stood when the turn began, including the user message
      // that started it. A client reopening mid-turn replays up to here and
      // plays the events over the top.
      baseCount: store.messages(chat.id).length
    };
    runs.set(chat.id, run);

    const emit = (event) => {
      run.events.push(event);
      for (const sub of run.subs) {
        try { sub.write(`data: ${JSON.stringify(event)}\n\n`); } catch { run.subs.delete(sub); }
      }
    };

    emit({ type: 'chat', id: chat.id, title: chat.title });

    run.promise = (async () => {
      try {
        await runChat({ cfg, chatId: chat.id, store, tools, hub, emit, signal: run.ac.signal, historyFromSeq });
      } catch (err) {
        emit({ type: 'error', error: run.ac.signal.aborted ? 'Stopped.' : err.message });
      } finally {
        store.touchChat(chat.id);
        run.done = true;
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

  function launchAutomationRun(automation, runId) {
    const chat = store.getChat(automation.chatId, automation.userId);
    if (!chat) {
      store.updateAutomationRun(runId, { status: 'failed', finishedAt: Date.now(), error: 'Target chat no longer exists.' });
      return false;
    }
    if (isRunning(chat.id)) return false;
    const firstSeq = store.addMessage(chat.id, { role: 'user', content: runMessage(automation) });
    store.updateAutomationRun(runId, { status: 'running', startedAt: Date.now() });
    startRun({ chat, tools: hub.activeTools(cfg.disabledTools), onFinish: ({ ok, error, result }) => {
      store.updateAutomationRun(runId, {
        status: ok ? 'completed' : 'failed', finishedAt: Date.now(),
        result: String(result || '').slice(0, 4000), error: error ? String(error).slice(0, 1000) : null
      });
      armScheduler();
    }, historyFromSeq: firstSeq });
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

  /**
   * The one auth gate for the whole handler. A no-op when authMode is
   * 'none' -- ctx.userId stays null, exactly today's unscoped behavior --
   * so every existing route below is unaffected until auth is opted into.
   */
  function resolveAuth(req) {
    if (cfg.authMode === 'none') return { userId: null, role: null, user: null };
    const pathname = (req.url || '').split('?')[0];
    const user = getSessionUser(req, store, cfg);
    if (!user && !isPreAuthPath(pathname)) return { unauthorized: true };
    if (user && user.status !== 'approved' && !isPreAuthPath(pathname)) return { pending: true };
    return { userId: user?.id ?? null, role: user?.role ?? null, user };
  }

  const server = createServer(async (req, res) => {
    try {
      const auth = resolveAuth(req);
      if (auth.unauthorized) return json(res, 401, { error: 'unauthorized' });
      if (auth.pending) return json(res, 403, { error: 'pending_approval' });

      if (req.method === 'GET' && req.url === '/api/auth/me') {
        return json(res, 200, {
          authMode: cfg.authMode,
          user: auth.user
            ? { id: auth.user.id, email: auth.user.email, role: auth.user.role, status: auth.user.status }
            : null
        });
      }

      if (req.method === 'GET' && req.url === '/api/config') {
        return json(res, 200, {
          ...publicConfig(cfg),
          tools: hub.tools.map((t) => ({
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters
          })),
          mcpErrors: hub.errors
        });
      }

      if (req.method === 'POST' && req.url === '/api/config') {
        cfg = saveConfig(await readJson(req));
        return json(res, 200, publicConfig(cfg));
      }

      // The grouped view behind the tools panel: built-ins, and every MCP
      // server's tools under it with that server's connection health.
      if (req.method === 'GET' && req.url === '/api/tools') {
        return json(res, 200, { ...hub.inventory(cfg.disabledTools), disabledTools: cfg.disabledTools || [] });
      }

      if (req.method === 'POST' && req.url === '/api/tools/toggle') {
        const { name, disabled } = await readJson(req);
        if (!name) return json(res, 400, { error: 'name is required' });
        const set = new Set(cfg.disabledTools || []);
        if (disabled) set.add(name); else set.delete(name);
        cfg = saveConfig({ disabledTools: [...set] });
        return json(res, 200, { ...hub.inventory(cfg.disabledTools), disabledTools: cfg.disabledTools });
      }

      if (req.method === 'GET' && req.url === '/api/mcp') {
        return json(res, 200, { path: mcpPath(), text: readMcpFile() });
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
          updated = saveMcpFile(JSON.stringify({ mcpServers: servers }, null, 2));
        } catch (err) {
          return json(res, 400, { error: err.message });
        }
        const old = hub;
        hub = await connectHub(updated);
        await old.close();
        console.log(`[tinywebui] mcp reloaded: ${hub.tools.length} tool(s)`);
        return json(res, 200, { ...hub.inventory(cfg.disabledTools), disabledTools: cfg.disabledTools || [] });
      }

      if (req.method === 'POST' && req.url === '/api/mcp') {
        const { text } = await readJson(req);
        let servers;
        try {
          servers = saveMcpFile(text);
        } catch (err) {
          return json(res, 400, { error: err.message });
        }
        // Swap the hub wholesale: old child processes are shut down before the
        // new ones start, so a rename cannot leave an orphan behind.
        const old = hub;
        hub = await connectHub(servers);
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
        const results = store.search(q, limit * 2)
          .filter((r) => !isRunning(r.chatId))
          .slice(0, limit);
        return json(res, 200, { results });
      }

      if (req.method === 'GET' && (req.url || '').split('?')[0] === '/api/usage') {
        return json(res, 200, { days: store.usageRollup(auth.userId), statistics: store.usageStatistics(auth.userId) });
      }

      if (req.method === 'GET' && req.url === '/api/folders') {
        return json(res, 200, { folders: store.listFolders() });
      }

      if (req.method === 'POST' && req.url === '/api/folders') {
        const { name } = await readJson(req);
        const created = store.createFolder(name);
        if (!created) return json(res, 400, { error: 'folder name required' });
        return json(res, 200, { folder: created });
      }

      if (req.method === 'GET' && req.url === '/api/automations') {
        return json(res, 200, { automations: store.listAutomations(auth.userId), chats: store.listChats(200, auth.userId) });
      }
      if (req.method === 'POST' && req.url === '/api/automations') {
        const body = await readJson(req);
        const chat = store.getChat(String(body.chatId || ''), auth.userId);
        if (!chat) return json(res, 400, { error: 'a chat you own is required' });
        const name = String(body.name || '').trim();
        const prompt = String(body.prompt || '').trim();
        if (!name || !prompt) return json(res, 400, { error: 'name and prompt are required' });
        if (name.length > 120 || prompt.length > 12000) return json(res, 400, { error: 'name or prompt is too long' });
        let schedule;
        try { schedule = validateSchedule(body.cron, body.timezone); }
        catch (err) { return json(res, 400, { error: err.message }); }
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
        if (folder) store.createFolder(folder);
        const updated = store.organizeChat(organize[1], { folder, tags });
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
          documents: store.listDocuments(found.id)
        });
      }

      // Uploads (including the paste-as-file path) land here before the first
      // message exists, so the chat is created lazily, the same way /api/chat
      // creates one for a brand-new conversation.
      const uploadDoc = /^\/api\/chats\/([\w.-]+)\/documents$/.exec(req.url || '');
      if (uploadDoc && req.method === 'POST') {
        const [, chatId] = uploadDoc;
        const { filename, mime, dataBase64 } = await readJson(req);
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

        const chat = store.getChat(chatId, auth.userId) || store.createChat({ id: chatId, title: String(filename).slice(0, 60) }, auth.userId);
        const doc = store.addDocument(chat.id, { filename: String(filename), mime: mime || null, content: text });
        return json(res, 200, { chatId: chat.id, document: doc });
      }

      // Converts one staged image to a wire-safe format before it's ever sent,
      // so the composer's own preview and the optimistic thumbnail in the
      // transcript show the same bytes the model (and the store) end up with,
      // instead of a HEIC/AVIF the browser can't decode until the turn ends
      // and the chat reloads with what the server stored.
      if (req.method === 'POST' && req.url === '/api/images/normalize') {
        const { mime, dataBase64 } = await readJson(req);
        const normalized = await normalizeUpload(mime, dataBase64);
        if (!normalized) return json(res, 400, { error: 'unrecognized or oversized image' });
        return json(res, 200, normalized);
      }

      // Lets the "files" rail open a document's full extracted text -- the
      // same content the model reads via read_document, in a plain new tab.
      const docContent = /^\/api\/documents\/([\w.-]+)$/.exec(req.url || '');
      if (docContent && req.method === 'GET') {
        const doc = store.getDocument(docContent[1]);
        if (!doc) return json(res, 404, { error: 'no such document' });
        return json(res, 200, { filename: doc.filename, mime: doc.mime, content: doc.content });
      }
      // Artifacts have no delete route of their own: the rail is a record of
      // what the conversation actually used, and the only way one goes away
      // is editing the message that attached it and dropping it there -- see
      // /edit below, which is the only place store.deleteDocument is called.

      const stream = /^\/api\/chats\/([\w.-]+)\/stream$/.exec((req.url || '').split('?')[0]);
      if (stream && req.method === 'GET') {
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

        const { seq, message, documentIds, removeDocumentIds, images } = await readJson(req);
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
          store.deleteDocument(docId);
        }
        let content = text;
        for (const docId of Array.isArray(documentIds) ? documentIds : []) {
          const doc = store.getDocument(docId);
          if (doc) content += attachmentNote(doc);
        }
        const kept = Array.isArray(images) ? images.filter((img) => img?.mime && img?.data) : [];
        store.addMessage(id, { role: 'user', content, ...(kept.length ? { images: kept } : {}) });

        // The run is started but not streamed back here. The client reloads the
        // rewound transcript and then attaches, the same path a reload takes,
        // rather than reading a stream through a response it also has to
        // redraw behind.
        startRun({ chat: found, tools: hub.activeTools(cfg.disabledTools) });
        return json(res, 200, { ok: true, running: true });
      }

      const stop = /^\/api\/chats\/([\w.-]+)\/stop$/.exec(req.url || '');
      if (stop && req.method === 'POST') {
        runs.get(stop[1])?.ac.abort();
        return json(res, 200, { ok: true });
      }
      if (one && req.method === 'DELETE') {
        if (!store.getChat(one[1], auth.userId)) return json(res, 404, { error: 'no such chat' });
        store.deleteChat(one[1]);
        return json(res, 200, { ok: true });
      }

      // One-shot migration for transcripts still sitting in localStorage.
      // Imported tool results become artifacts like any other, so an old chat
      // is compactable the moment it is carried over.
      if (req.method === 'POST' && req.url === '/api/chats/import') {
        const { chats = [] } = await readJson(req);
        let imported = 0;
        for (const c of chats) {
          if (!c?.id || store.getChat(c.id, auth.userId)) continue;
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
        const { chatId, message, documentIds, images } = await readJson(req);
        if (!cfg.apiKey) return json(res, 400, { error: 'No API key. Set TINYWEBUI_API_KEY or apiKey in the config file.' });
        if (!message) return json(res, 400, { error: 'message is required' });

        // The client no longer ships the transcript: it sends the new turn and
        // the server replays what it already holds. That is what stops a
        // page-sized tool result from crossing the wire on every message.
        const chat = (chatId && store.getChat(chatId, auth.userId))
          || store.createChat({ id: chatId, title: String(message).slice(0, 60) }, auth.userId);

        // Attachments are surfaced as plain text inline notes rather than a
        // system-prompt change, the same idiom compact.js uses for a compacted
        // artifact -- the model sees "[Attached document: ...]" in the message
        // it's already reading and knows to call read_document on the id.
        let content = String(message);
        for (const id of Array.isArray(documentIds) ? documentIds : []) {
          const doc = store.getDocument(id);
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
          : startRun({ chat, tools: hub.activeTools(cfg.disabledTools) });
        return attach(run, res, 0);
      }

      return serveStatic(req, res);
    } catch (err) {
      if (!res.headersSent) json(res, 500, { error: err.message });
      else res.end();
    }
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  armScheduler();
  console.log(`[tinywebui] http://${host}:${port}`);

  // Real teardown, reused two ways: on SIGINT/SIGTERM it exits the process, and
  // as `server.shutdown()` it does not -- which is what a test harness needs,
  // since `process.kill(pid, 'SIGTERM')` is not something to lean on across
  // platforms and exiting the test runner's own process is not what a test
  // closing its server wants anyway.
  const shutdown = async () => {
    schedulerStopped = true;
    if (scheduleTimer) clearTimeout(scheduleTimer);
    await hub.close();
    store.close();
    await new Promise((resolve) => server.close(resolve));
  };
  process.on('SIGINT', () => shutdown().then(() => process.exit(0)));
  process.on('SIGTERM', () => shutdown().then(() => process.exit(0)));

  server.shutdown = shutdown;
  return server;
}
