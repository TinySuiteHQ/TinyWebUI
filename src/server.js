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
  const rel = normalize(req.url.split('?')[0]).replace(/^(\.\.[/\\])+/, '');
  const file = join(PUBLIC_DIR, rel === '/' ? 'index.html' : rel);
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

      if (req.method === 'GET' && req.url === '/api/mcp') {
        return json(res, 200, { path: mcpPath(), text: readMcpFile() });
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
        return json(res, 200, { chats: store.listChats() });
      }

      const one = /^\/api\/chats\/([\w.-]+)$/.exec(req.url || '');
      if (one && req.method === 'GET') {
        const found = store.getChat(one[1]);
        if (!found) return json(res, 404, { error: 'no such chat' });
        return json(res, 200, {
          id: found.id,
          title: found.title,
          epoch: found.epoch,
          messages: store.messages(found.id).map(toView)
        });
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

        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive'
        });
        const emit = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
        const ac = new AbortController();
        req.on('close', () => ac.abort());

        emit({ type: 'chat', id: chat.id, title: chat.title });
        try {
          await runChat({ cfg, chatId: chat.id, store, tools: hub.tools, hub, emit, signal: ac.signal });
        } catch (err) {
          if (!ac.signal.aborted) emit({ type: 'error', error: err.message });
        }
        store.touchChat(chat.id);
        return res.end();
      }

      return serveStatic(req, res);
    } catch (err) {
      if (!res.headersSent) json(res, 500, { error: err.message });
      else res.end();
    }
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  console.log(`[tinywebui] http://${host}:${port}`);

  const shutdown = async () => {
    await hub.close();
    store.close();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return server;
}
