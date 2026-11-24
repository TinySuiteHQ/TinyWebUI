// A model calling an MCP tool by its bare name, end to end through the HTTP
// server: a fake OpenAI-compatible provider, a real streamable-HTTP MCP server
// behind the hub, and the same routes the app uses (an automation's "run now"
// for the unattended case, POST /api/chat for the interactive one).
//
// The tool is exposed as `clock__get_current_datetime` and is auto-approved
// under toolApproval 'writes'. The model writes the bare
// `get_current_datetime`. Before the fix, the approval gate saw the bare name
// before anything routed it, found no such tool, treated it as "may write" and
// refused the unattended run with "needs the user's approval", so the tool
// never ran. An unknown bare name in an interactive turn was put to the user
// for approval though no such tool exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMcpHttpServer } from './mcp-http-fixture.js';

const NOW = '2026-01-02T03:04:05Z';
const FULL = 'clock__get_current_datetime';

// The MCP server: a real one, spoken to over streamable HTTP. Each call the
// tool receives is recorded by the fixture.
const clock = await startMcpHttpServer({
  setup(server, { calls }) {
    server.registerTool('get_current_datetime', { description: 'Returns the current date and time (UTC).' }, async () => {
      calls.push({ tool: 'get_current_datetime' });
      return { content: [{ type: 'text', text: `now=${NOW}` }] };
    });
  }
});

// The provider: the first request of a turn calls `toolName` as written (bare);
// the request after the tool result answers in text. Every body is recorded.
let toolName = 'get_current_datetime';
const requests = [];
const fake = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    if (req.url.endsWith('/models')) { res.writeHead(404); return res.end(); }
    const parsed = JSON.parse(body);
    requests.push(parsed);
    const afterTool = parsed.messages.at(-1).role === 'tool';
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = afterTool
      ? { content: 'done' }
      : { tool_calls: [{ index: 0, id: `call_${requests.length}`, type: 'function', function: { name: toolName, arguments: '{}' } }] };
    res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
});
const port = await new Promise((r) => fake.listen(0, '127.0.0.1', () => r(fake.address().port)));

const dir = mkdtempSync(join(tmpdir(), 'tinywebui-bare-e2e-'));
const dbPath = join(dir, 'chats.db');
const { start } = await import('../server/server.ts');
const srv = await start({
  port: 0, host: '127.0.0.1', configFile: false, dbPath,
  mcpServers: { clock: { url: clock.url } },
  config: {
    authMode: 'local',
    baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', model: 'fake-model',
    autoTitle: false,
    toolApproval: 'writes',
    autoApproveTools: [FULL]
  }
});
const base = `http://127.0.0.1:${srv.address().port}`;

test.after(async () => {
  await srv.shutdown(); fake.close(); await clock.close();
  rmSync(dir, { recursive: true, force: true });
});

const call = async (method, path, body) => {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, data: await res.json().catch(() => null) };
};

/** Reads an event stream to its end, answering any approval with `decide`. */
async function readEvents(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buf = '';
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
      await onEvent?.(ev);
    }
  }
  return events;
}

/** The tool names stored with each tool result of a chat (its artifacts). */
async function storedToolNames(chatId) {
  const { Store } = await import('../server/store/index.ts');
  const store = new Store(dbPath);
  try {
    return store.messages.list(chatId).filter((m) => m.role === 'tool')
      .map((m) => store.messages.getArtifact(m.artifact_id, chatId)?.tool_name);
  } finally { store.close(); }
}

test('unattended: a bare name for an auto-approved MCP tool runs it, through an automation run', async () => {
  toolName = 'get_current_datetime';
  requests.length = 0;
  clock.calls.length = 0;

  const created = await call('POST', '/api/automations', {
    name: 'clock check', prompt: 'What time is it?', cron: '0 0 1 1 *', timezone: 'UTC', enabled: false, newChatTitle: 'Clock'
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const { id, chatId } = created.data.automation;

  // "Run now": the same scheduler launch a scheduled occurrence takes, unattended.
  const triggered = await call('POST', `/api/automations/${id}/trigger`);
  assert.equal(triggered.status, 202, JSON.stringify(triggered.data));
  const deadline = Date.now() + 30_000;
  let run;
  for (;;) {
    run = (await call('GET', `/api/automations/${id}/runs`)).data.runs.find((r) => r.id === triggered.data.run.runId);
    if (['completed', 'failed', 'skipped'].includes(run?.status)) break;
    assert.ok(Date.now() < deadline, `run never finished: ${JSON.stringify(run)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(run.status, 'completed', JSON.stringify(run));

  // What the model got back is the tool's output, not a refusal. Checked
  // first, so a failure shows the text the model was actually handed.
  assert.equal(requests.length, 2, 'one tool round, then the answer');
  assert.equal(requests[0].messages.at(-1).role, 'user');
  const toolMsg = requests[1].messages.at(-1);
  assert.equal(toolMsg.role, 'tool');
  assert.doesNotMatch(toolMsg.content, /needs the user's approval|unknown tool/, `the model was handed: ${toolMsg.content}`);
  assert.ok(toolMsg.content.startsWith(`now=${NOW}`), toolMsg.content);

  // The MCP server received the call.
  assert.deepEqual(clock.calls.map((c) => c.tool), ['get_current_datetime'], 'the MCP tool ran once');

  // Stored and emitted under the full name.
  assert.deepEqual(await storedToolNames(chatId), [FULL]);
  const stream = await fetch(`${base}/api/chats/${chatId}/stream?from=0`);
  assert.equal(stream.status, 200, 'the finished run is still retained for replay');
  const events = await readEvents(stream);
  assert.deepEqual(events.filter((e) => e.type === 'tool_call').map((e) => e.name), [FULL]);
  assert.deepEqual(events.filter((e) => e.type === 'tool_result').map((e) => e.name), [FULL]);
  assert.ok(!events.some((e) => e.type === 'approval'));
});

test('interactive: an unknown bare name is answered "unknown tool", never put to the user', async () => {
  toolName = 'nope_tool';
  requests.length = 0;
  clock.calls.length = 0;

  const res = await fetch(`${base}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'use nope_tool' })
  });
  assert.equal(res.status, 200);
  let chatId = null;
  const events = await readEvents(res, async (ev) => {
    if (ev.type === 'chat') chatId = ev.id;
    // Should never happen; if it does, decline so the turn still ends and the asserts below report it.
    if (ev.type === 'approval') await call('POST', `/api/chats/${chatId}/approve`, { id: ev.id, decision: 'deny' });
  });

  assert.deepEqual(events.filter((e) => e.type === 'approval').map((e) => e.name), [], 'no approval asked for a tool that does not exist');
  const results = events.filter((e) => e.type === 'tool_result').map((e) => String(e.result));
  assert.equal(results.length, 1);
  assert.ok(results[0].startsWith('Error: unknown tool "nope_tool"'), results[0]);
  assert.equal(clock.calls.length, 0);
  assert.equal(requests.length, 2);
  assert.ok(requests[1].messages.at(-1).content.startsWith('Error: unknown tool "nope_tool"'));
});
