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
import { expandToolDef, callExpand } from './context_tool.js';

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

  // context_expand is ours, not an MCP server's, but the model should not be
  // able to tell: it is registered onto the same hub and called the same way.
  const connectHub = async (servers) =>
    (await new McpHub(servers).connect())
      .registerLocal(expandToolDef(), (args, ctx) => callExpand(args, { ...ctx, store }));

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

  function startRun({ chat, tools }) {
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
        await runChat({ cfg, chatId: chat.id, store, tools, hub, emit, signal: run.ac.signal });
      } catch (err) {
        emit({ type: 'error', error: run.ac.signal.aborted ? 'Stopped.' : err.message });
      } finally {
        store.touchChat(chat.id);
        run.done = true;
        for (const sub of run.subs) { try { sub.end(); } catch { /* already gone */ } }
        run.subs.clear();
        // Held briefly so a client reconnecting a second later still gets the
        // tail of the turn rather than a 404.
        setTimeout(() => { if (runs.get(chat.id) === run) runs.delete(chat.id); }, RETAIN_MS).unref();
      }
    })();

    return run;
  }

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

  const server = createServer(async (req, res) => {
    try {
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

      if (req.method === 'GET' && req.url === '/api/chats') {
        // `running` is what puts the dot in the sidebar: a turn belongs to the
        // server, so a chat can be working while nothing is watching it.
        const list = store.listChats().map((c) => ({ ...c, running: isRunning(c.id) }));
        return json(res, 200, { chats: list });
      }

      const one = /^\/api\/chats\/([\w.-]+)$/.exec(req.url || '');
      if (one && req.method === 'GET') {
        const found = store.getChat(one[1]);
        if (!found) return json(res, 404, { error: 'no such chat' });
        const run = runs.get(found.id);
        const live = run && !run.done;
        const messages = store.messages(found.id).map(toView);
        return json(res, 200, {
          id: found.id,
          title: found.title,
          epoch: found.epoch,
          // A turn in flight has already written some of itself to the store.
          // Cutting the transcript back to where the turn began lets the client
          // replay the settled part and then play the run's events over the top,
          // instead of rendering the same rounds twice.
          messages: live ? messages.slice(0, run.baseCount) : messages,
          running: Boolean(live)
        });
      }

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
        const found = store.getChat(id);
        if (!found) return json(res, 404, { error: 'no such chat' });
        // Rewriting history under a turn that is still reading it would leave
        // the run answering a question that no longer exists.
        if (isRunning(id)) return json(res, 409, { error: 'that chat is still working; stop it first' });

        const { seq, message } = await readJson(req);
        const text = String(message ?? '').trim();
        if (!text) return json(res, 400, { error: 'message is required' });
        const target = store.messages(id).find((m) => m.seq === Number(seq));
        if (!target || target.role !== 'user') {
          return json(res, 400, { error: 'seq must name a question of your own' });
        }

        store.truncateFrom(id, Number(seq));
        store.addMessage(id, { role: 'user', content: text });

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
          if (!c?.id || store.getChat(c.id)) continue;
          store.createChat({ id: c.id, title: c.title || 'Imported chat', createdAt: c.updated || Date.now() });
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
        return json(res, 200, { imported, chats: store.listChats() });
      }

      if (req.method === 'POST' && req.url === '/api/chat') {
        const { chatId, message } = await readJson(req);
        if (!cfg.apiKey) return json(res, 400, { error: 'No API key. Set TINYWEBUI_API_KEY or apiKey in the config file.' });
        if (!message) return json(res, 400, { error: 'message is required' });

        // The client no longer ships the transcript: it sends the new turn and
        // the server replays what it already holds. That is what stops a
        // page-sized tool result from crossing the wire on every message.
        const chat = (chatId && store.getChat(chatId))
          || store.createChat({ id: chatId, title: String(message).slice(0, 60) });
        store.addMessage(chat.id, { role: 'user', content: String(message) });

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
  console.log(`[tinywebui] http://${host}:${port}`);

  // Real teardown, reused two ways: on SIGINT/SIGTERM it exits the process, and
  // as `server.shutdown()` it does not -- which is what a test harness needs,
  // since `process.kill(pid, 'SIGTERM')` is not something to lean on across
  // platforms and exiting the test runner's own process is not what a test
  // closing its server wants anyway.
  const shutdown = async () => {
    await hub.close();
    store.close();
    await new Promise((resolve) => server.close(resolve));
  };
  process.on('SIGINT', () => shutdown().then(() => process.exit(0)));
  process.on('SIGTERM', () => shutdown().then(() => process.exit(0)));

  server.shutdown = shutdown;
  return server;
}
