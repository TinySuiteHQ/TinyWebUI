// The settings-panel routes, against a real (toy) MCP server and a real
// completions endpoint, so "a disabled tool never reaches the model" is
// checked on the actual wire, not on an assumption about it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOY = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'toy-mcp-server.mjs');

let lastBody = null;
const fake = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    lastBody = JSON.parse(body);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
const port = await new Promise((r) => fake.listen(0, '127.0.0.1', () => r(fake.address().port)));

const dir = mkdtempSync(join(tmpdir(), 'tinywebui-toolspanel-'));
process.env.TINYWEBUI_CONFIG = join(dir, 'config.json');
process.env.TINYWEBUI_MCP = join(dir, 'mcp.json');
process.env.TINYWEBUI_API_KEY = 'test-key';
process.env.TINYWEBUI_BASE_URL = `http://127.0.0.1:${port}/v1`;
process.env.TINYWEBUI_MODEL = 'fake-model';
process.env.TINYWEBUI_DB = join(dir, 'chats.db');

writeFileSync(process.env.TINYWEBUI_MCP, JSON.stringify({
  mcpServers: { toy: { command: process.execPath, args: [TOY] } }
}));

const { start } = await import('../src/server.js');
const srv = await start({ port: 0, host: '127.0.0.1' });
const base = `http://127.0.0.1:${srv.address().port}`;

const get = async (path) => (await fetch(`${base}${path}`)).json();
const post = async (path, body) => {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

test('the inventory lists the built-in and the toy server together, both healthy', async () => {
  const inv = await get('/api/tools');
  assert.deepEqual(inv.internal.map((t) => t.name), ['context_expand']);

  const toy = inv.servers.find((s) => s.name === 'toy');
  assert.ok(toy, 'the configured server shows up even before anything is toggled');
  assert.equal(toy.status, 'ok');
  assert.deepEqual(toy.tools.map((t) => t.name).sort(), ['toy__boom', 'toy__echo']);
  assert.ok(inv.servers.every((s) => s.tools.every((t) => t.disabled === false)));
});

test('disabling a tool keeps it in the inventory but drops it from the wire', async () => {
  const disable = await post('/api/tools/toggle', { name: 'toy__echo', disabled: true });
  assert.equal(disable.status, 200);
  const toy = disable.body.servers.find((s) => s.name === 'toy');
  assert.equal(toy.tools.find((t) => t.name === 'toy__echo').disabled, true);
  assert.equal(toy.tools.find((t) => t.name === 'toy__boom').disabled, false, 'only the named tool is touched');

  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'hi' })
  });
  await res.text();
  const names = (lastBody.tools || []).map((t) => t.function.name);
  assert.ok(!names.includes('toy__echo'), 'the disabled tool was never offered to the model');
  assert.ok(names.includes('toy__boom'), 'its sibling still was');
  assert.ok(names.includes('context_expand'), 'as was the untouched built-in');

  await post('/api/tools/toggle', { name: 'toy__echo', disabled: false });
});

test('disabling a server actually disconnects it, and it stops appearing among the offered tools', async () => {
  const off = await post('/api/mcp/servers/toy/toggle', { disabled: true });
  assert.equal(off.status, 200);
  const toy = off.body.servers.find((s) => s.name === 'toy');
  assert.equal(toy.status, 'disabled');
  assert.deepEqual(toy.tools, [], 'a disabled server is not connected, so it has nothing to list');

  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'hi again' })
  });
  await res.text();
  const names = (lastBody.tools || []).map((t) => t.function.name);
  assert.ok(!names.some((n) => n.startsWith('toy__')), 'nothing from the disconnected server was offered');

  const on = await post('/api/mcp/servers/toy/toggle', { disabled: false });
  assert.equal(on.body.servers.find((s) => s.name === 'toy').status, 'ok', 'and it reconnects on request');
});

test('toggling an unknown server is a 404, and an unnamed tool toggle is a 400', async () => {
  assert.equal((await post('/api/mcp/servers/nope/toggle', { disabled: true })).status, 404);
  assert.equal((await post('/api/tools/toggle', { disabled: true })).status, 400);
});

test.after(async () => {
  // srv.close() alone only stops accepting new connections -- the live hub
  // still has a real 'toy' child process attached. shutdown() is the same
  // teardown the app runs on SIGINT/SIGTERM, without exiting this process.
  await srv.shutdown();
  fake.close();
});
