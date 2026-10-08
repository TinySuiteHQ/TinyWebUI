// Approval end to end through the HTTP server: a real (toy) MCP tool, a fake
// provider that calls it, and the same routes the transcript's buttons use.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOY = join(dirname(fileURLToPath(import.meta.url)), '..', 'test-fixtures', 'toy-mcp-server.mjs');

// First request of a turn calls toy__echo; the one after the result answers.
const fake = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const { messages } = JSON.parse(body);
    const afterTool = messages.at(-1).role === 'tool';
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = afterTool
      ? { content: `saw: ${messages.at(-1).content.split('\n')[0]}` }
      : { tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: 'function', function: { name: 'toy__echo', arguments: '{"text":"hi"}' } }] };
    res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
const port = await new Promise((r) => fake.listen(0, '127.0.0.1', () => r(fake.address().port)));

const dir = mkdtempSync(join(tmpdir(), 'tinywebui-approval-'));
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
const srv = await start({ port: 0, host: '127.0.0.1', config: { authMode: 'none' } });
const base = `http://127.0.0.1:${srv.address().port}`;

const post = (path, body) => fetch(`${base}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
});

/** Sends a message and reads its event stream, answering approvals with `decide`. */
async function converse(message, decide, chatId) {
  const res = await post('/api/chat', { message, ...(chatId ? { chatId } : {}) });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buf = '';
  let id = chatId;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 2);
      if (!line.startsWith('data:')) continue;
      const ev = JSON.parse(line.slice(5));
      events.push(ev);
      if (ev.type === 'chat') id = ev.id;
      if (ev.type === 'approval') {
        const r = await post(`/api/chats/${id}/approve`, { id: ev.id, decision: decide });
        assert.equal(r.status, 200);
      }
    }
  }
  return { events, chatId: id };
}

// shutdown(), not close(): the hub has a live toy child process attached, and
// the scheduler's timer would otherwise keep this test process alive.
test.after(async () => { await srv.shutdown(); fake.close(); });

test('an MCP tool with no read-only hint waits for approval under the default policy', async () => {
  const { events } = await converse('echo hi', 'allow');
  const types = events.map((e) => e.type);
  assert.ok(types.indexOf('approval') < types.indexOf('tool_result'), 'asked before running');
  assert.equal(events.find((e) => e.type === 'tool_result').result, 'hi');
  assert.equal(events.find((e) => e.type === 'approval_done').decision, 'allow');
});

test('deny: the tool never runs and the model is told why', async () => {
  const { events } = await converse('echo hi', 'deny');
  assert.match(events.find((e) => e.type === 'tool_result').result, /^The user declined this call/);
});

test('always allow: saved to the config, shown in the panel, and never asked again', async () => {
  const first = await converse('echo hi', 'always');
  assert.ok(first.events.some((e) => e.type === 'approval'));
  assert.deepEqual(JSON.parse(readFileSync(process.env.TINYWEBUI_CONFIG, 'utf8')).autoApproveTools, ['toy__echo']);

  const tools = await (await fetch(`${base}/api/tools`)).json();
  const echo = tools.servers.find((s) => s.name === 'toy').tools.find((t) => t.name === 'toy__echo');
  assert.equal(echo.approval, 'auto');
  assert.equal(tools.internal[0].approval, undefined, 'built-ins carry no approval state');

  const again = await converse('echo hi', 'deny');
  assert.ok(!again.events.some((e) => e.type === 'approval'), 'trusted now');
  assert.equal(again.events.find((e) => e.type === 'tool_result').result, 'hi');

  // And back: the panel's "always ask" puts the prompt back.
  const r = await post('/api/tools/approval', { name: 'toy__echo', policy: 'ask' });
  assert.equal(r.status, 200);
  const asked = await converse('echo hi', 'allow');
  assert.ok(asked.events.some((e) => e.type === 'approval'));
});

test('answering a call that is not waiting is refused', async () => {
  const { chatId } = await converse('echo hi', 'allow');
  const r = await post(`/api/chats/${chatId}/approve`, { id: 'nope', decision: 'allow' });
  assert.equal(r.status, 409);
});
