// manage_mcp: the model edits mcp.json, writes secrets it can never read back,
// and every change waits for the user.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callManageMcp, mcpToolDef, MANAGE_MCP } from '../src/tools/mcp_tool.js';
import { McpHub, expandRefs, uniqueName } from '../src/mcp.js';
import { approvalFor } from '../src/config/approval.js';

const SECRET = 'sk-live-ABC123XYZ';

/** The slice of the server that manage_mcp talks to, over an in-memory file. */
function fakeMcp(initial = {}, { locked = false, invalid = false, live = {} } = {}) {
  let servers = structuredClone(initial);
  const saves = [];
  return {
    saves,
    get file() { return servers; },
    locked: () => locked,
    servers() {
      if (invalid) throw new Error('mcp.json is not valid JSON');
      return structuredClone(servers);
    },
    save(next, change) { servers = structuredClone(next); saves.push(change); },
    status: () => live,
    check: () => null
  };
}
const call = (mcp, args) => callManageMcp(args, { mcp, chatId: 'c1' });

/* ---------- what the model may read ---------- */

test('list never shows a secret: headers, env, URL and credential flags are hidden', () => {
  const mcp = fakeMcp({
    gh: {
      url: `https://api.example.com/mcp/AbCdEfGhIjKlMnOpQrStUv123?key=SECRETKEY99&v=1`,
      headers: { Authorization: `Bearer ${SECRET}`, 'X-Ref': 'Bearer ${TOKEN}' }
    },
    loc: {
      command: 'npx',
      args: ['-y', 'pkg', '--api-key', SECRET, `--token=${SECRET}`, '--port', '80'],
      env: { API_KEY: SECRET, MODE: '${MODE}' }
    }
  }, { live: { gh: { status: 'error', error: `401 for Bearer ${SECRET}`, tools: 0 } } });

  const out = call(mcp, { action: 'list' });
  for (const leaked of [SECRET, 'SECRETKEY99', 'AbCdEfGhIjKlMnOpQrStUv123']) {
    assert.ok(!out.includes(leaked), `${leaked} must not appear in the result`);
  }
  const { servers, editable } = JSON.parse(out);
  assert.equal(editable, true);
  const gh = servers.find((s) => s.name === 'gh');
  assert.equal(gh.headers.Authorization, '<hidden>', 'the name is shown, the value is not');
  assert.equal(gh.headers['X-Ref'], 'Bearer ${TOKEN}', 'a pure reference holds no secret, so it is shown');
  assert.match(gh.url, /^https:\/\/api\.example\.com\/mcp\/<hidden>\?key=<hidden>&v=<hidden>$/);
  assert.match(gh.error, /401 for <hidden>/, 'an error that quotes a secret is cleaned');
  const loc = servers.find((s) => s.name === 'loc');
  assert.deepEqual(loc.args, ['-y', 'pkg', '--api-key', '<hidden>', '--token=<hidden>', '--port', '80']);
  assert.deepEqual(loc.env, { API_KEY: '<hidden>', MODE: '${MODE}' });
});

/* ---------- writing, and patching without echoing ---------- */

test('add stores the key, reports names only, and says how to keep it out of the file', () => {
  const mcp = fakeMcp();
  const out = call(mcp, { action: 'add', name: 'gh', url: 'https://api.example.com/mcp', headers: { Authorization: `Bearer ${SECRET}` } });
  assert.ok(!out.includes(SECRET), 'the key is never echoed back');
  const res = JSON.parse(out);
  assert.equal(res.saved, true);
  assert.deepEqual(res.server.headers, { Authorization: '<hidden>' });
  assert.match(res.hint, /Authorization is stored as plain text/);
  assert.equal(mcp.file.gh.headers.Authorization, `Bearer ${SECRET}`, 'the file has the real value');
  assert.deepEqual(mcp.saves[0], { by: 'assistant (chat c1)', change: { action: 'add', name: 'gh' } });
});

test('a ${NAME} reference needs no warning and keeps the key out of the file', () => {
  const mcp = fakeMcp();
  const res = JSON.parse(call(mcp, { action: 'add', name: 'gh', url: 'https://api.example.com/mcp', headers: { Authorization: 'Bearer ${GH_TOKEN}' } }));
  assert.equal(res.hint, undefined);
  assert.equal(res.server.headers.Authorization, 'Bearer ${GH_TOKEN}');
});

test('update merges headers by name: unnamed ones are kept untouched, null removes', () => {
  const mcp = fakeMcp({ gh: { url: 'https://api.example.com/mcp', headers: { Authorization: `Bearer ${SECRET}`, 'X-A': '1' } } });
  const out = call(mcp, { action: 'update', name: 'gh', headers: { 'X-B': '2', 'X-A': null } });
  assert.ok(!out.includes(SECRET));
  assert.deepEqual(mcp.file.gh.headers, { Authorization: `Bearer ${SECRET}`, 'X-B': '2' });

  call(mcp, { action: 'update', name: 'gh', url: 'https://other.example.com/mcp' });
  assert.equal(mcp.file.gh.headers.Authorization, `Bearer ${SECRET}`, 'changing the URL leaves the key alone');

  call(mcp, { action: 'update', name: 'gh', headers: { Authorization: null, 'X-B': null } });
  assert.equal(mcp.file.gh.headers, undefined, 'an emptied map is dropped, not left as {}');
});

test('a local server: command, args and env; sse is recorded, plain http is the default', () => {
  const mcp = fakeMcp();
  call(mcp, { action: 'add', name: 'files', command: 'npx', args: ['-y', 'srv', '.'], env: { TOKEN: '${FILES_TOKEN}' } });
  assert.deepEqual(mcp.file.files, { command: 'npx', args: ['-y', 'srv', '.'], env: { TOKEN: '${FILES_TOKEN}' } });
  call(mcp, { action: 'add', name: 'live', url: 'https://a.example.com/sse', transport: 'sse' });
  assert.equal(mcp.file.live.transport, 'sse');
  call(mcp, { action: 'update', name: 'live', transport: 'http' });
  assert.equal(mcp.file.live.transport, undefined);
});

test('enable, disable and remove', () => {
  const mcp = fakeMcp({ a: { command: 'x' } });
  call(mcp, { action: 'disable', name: 'a' });
  assert.equal(mcp.file.a.disabled, true);
  call(mcp, { action: 'enable', name: 'a' });
  assert.equal(mcp.file.a.disabled, undefined);
  assert.equal(JSON.parse(call(mcp, { action: 'remove', name: 'a' })).saved, true);
  assert.deepEqual(mcp.file, {});
});

test('the model is told when a local command is not installed', () => {
  const mcp = { ...fakeMcp(), check: () => '"nope" was not found on PATH' };
  const res = JSON.parse(call(mcp, { action: 'add', name: 'x', command: 'nope' }));
  assert.equal(res.saved, true);
  assert.match(res.warning, /not found on PATH/);
});

test('plain http to another machine with headers is flagged', () => {
  const res = JSON.parse(call(fakeMcp(), { action: 'add', name: 'x', url: 'http://10.0.0.5/mcp', headers: { 'X-Key': '${K}' } }));
  assert.match(res.warning, /unencrypted/);
  const local = JSON.parse(call(fakeMcp(), { action: 'add', name: 'x', url: 'http://127.0.0.1:8000/mcp', headers: { 'X-Key': '${K}' } }));
  assert.equal(local.warning, undefined);
});

/* ---------- refusals ---------- */

test('bad calls are refused, name no values, and write nothing', () => {
  const mcp = fakeMcp({ a: { command: 'x' }, r: { url: 'https://a.example.com/mcp' } });
  const bad = (args, pattern) => {
    const out = call(mcp, args);
    assert.match(out, /^Error: /);
    assert.match(out, pattern);
    assert.ok(!out.includes(SECRET));
  };
  bad({ action: 'add', name: 'n', command: 'x', url: 'https://a.example.com' }, /either "command".*or "url"/);
  bad({ action: 'add', name: 'n' }, /either "command".*or "url"/);
  bad({ action: 'add', name: '../x', command: 'x' }, /"name" must be/);
  bad({ action: 'add', name: 'n', url: 'ftp://a.example.com' }, /http:\/\/ or https:\/\//);
  bad({ action: 'add', name: 'n', url: 'https://a.example.com', headers: { A: `x\r\nInjected: ${SECRET}` } }, /single-line/);
  bad({ action: 'add', name: 'n', url: 'https://a.example.com', headers: { 'bad name': 'v' } }, /invalid name/);
  bad({ action: 'add', name: 'a', command: 'x' }, /already exists/);
  bad({ action: 'update', name: 'missing', url: 'https://a.example.com' }, /no server named/);
  bad({ action: 'update', name: 'a' }, /at least one field/);
  bad({ action: 'update', name: 'a', url: 'https://a.example.com' }, /cannot be used with a local server/);
  bad({ action: 'update', name: 'r', command: 'x' }, /cannot be used with a remote server/);
  bad({ action: 'remove', name: 'missing' }, /no server named/);
  bad({ action: 'explode' }, /action must be one of/);
  assert.equal(mcp.saves.length, 0, 'nothing was saved by any of them');
});

test('a locked deployment can be read but not changed', () => {
  const mcp = fakeMcp({ a: { command: 'x' } }, { locked: true });
  assert.equal(JSON.parse(call(mcp, { action: 'list' })).editable, false);
  assert.match(call(mcp, { action: 'add', name: 'n', command: 'x' }), /locked in this deployment/);
  assert.match(call(mcp, { action: 'remove', name: 'a' }), /locked in this deployment/);
  assert.equal(mcp.saves.length, 0);
});

test('a mcp.json that does not parse is never overwritten with one new entry', () => {
  const mcp = fakeMcp({}, { invalid: true });
  assert.match(call(mcp, { action: 'add', name: 'n', command: 'x' }), /^Error: mcp\.json is not valid JSON/);
  assert.match(call(mcp, { action: 'list' }), /^Error: /);
  assert.equal(mcp.saves.length, 0);
});

/* ---------- approval ---------- */

function hubWithTool() {
  return new McpHub({}).registerLocal(mcpToolDef(), () => '', {
    readOnly: (a) => a?.action === 'list',
    gated: (a) => a?.action !== 'list',
    executionMode: 'sequential'
  });
}

test('every change asks, even with approval switched off; listing never does', () => {
  const hub = hubWithTool();
  for (const toolApproval of ['writes', 'all', 'off']) {
    assert.equal(approvalFor({ toolApproval }, hub, MANAGE_MCP, { action: 'add' }), 'ask', `mode ${toolApproval}`);
    assert.equal(approvalFor({ toolApproval }, hub, MANAGE_MCP, { action: 'list' }), 'auto');
  }
  assert.equal(approvalFor({ toolApproval: 'off', autoApproveTools: [MANAGE_MCP] }, hub, MANAGE_MCP, { action: 'remove' }), 'auto',
    'only the per-tool override in the config turns the prompt off');
});

test('the other built-ins still never ask', () => {
  const hub = new McpHub({}).registerLocal({ type: 'function', function: { name: 'manage_tasks' } }, () => '');
  assert.equal(approvalFor({ toolApproval: 'all' }, hub, 'manage_tasks', {}), 'auto');
});

test('an MCP server cannot take the name manage_mcp', () => {
  assert.equal(uniqueName('manage_mcp', new Map()), 'manage_mcp_2');
});

/* ---------- ${NAME} ---------- */

test('references fill in from the environment and fail loudly when unset', () => {
  const env = { GH_TOKEN: 'abc' };
  assert.equal(expandRefs('Bearer ${GH_TOKEN}', env), 'Bearer abc');
  assert.equal(expandRefs('no refs, a $ and {braces}', env), 'no refs, a $ and {braces}');
  assert.throws(() => expandRefs('Bearer ${MISSING_ONE}', env), /\$\{MISSING_ONE\}, which is not set/);
  assert.equal(expandRefs(42, env), 42);
});

/* ---------- end to end ---------- */

let nextArgs;
const fake = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const { messages } = JSON.parse(body);
    const afterTool = messages.at(-1).role === 'tool';
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = afterTool
      ? { content: 'done' }
      : { tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: 'function', function: { name: MANAGE_MCP, arguments: JSON.stringify(nextArgs) } }] };
    res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
const port = await new Promise((r) => fake.listen(0, '127.0.0.1', () => r(fake.address().port)));

const dir = mkdtempSync(join(tmpdir(), 'tinywebui-mcptool-'));
process.env.TINYWEBUI_CONFIG = join(dir, 'config.json');
process.env.TINYWEBUI_MCP = join(dir, 'mcp.json');
process.env.TINYWEBUI_API_KEY = 'test-key';
process.env.TINYWEBUI_BASE_URL = `http://127.0.0.1:${port}/v1`;
process.env.TINYWEBUI_MODEL = 'fake-model';
process.env.TINYWEBUI_DB = join(dir, 'chats.db');
// Approval is switched off: manage_mcp has to ask anyway.
writeFileSync(process.env.TINYWEBUI_CONFIG, JSON.stringify({ toolApproval: 'off' }));
writeFileSync(process.env.TINYWEBUI_MCP, JSON.stringify({ mcpServers: {} }));

const { start } = await import('../src/server.js');
const srv = await start({ port: 0, host: '127.0.0.1' });
const base = `http://127.0.0.1:${srv.address().port}`;
test.after(async () => { await srv.shutdown(); fake.close(); });

const post = (path, body) => fetch(`${base}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
});

async function converse(args, decision) {
  nextArgs = args;
  const res = await post('/api/chat', { message: 'set it up' });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buf = '';
  let id;
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
      if (ev.type === 'approval') assert.equal((await post(`/api/chats/${id}/approve`, { id: ev.id, decision })).status, 200);
    }
  }
  return events;
}
const servers = async () => (await (await fetch(`${base}/api/tools`)).json()).servers.map((s) => s.name);
const file = () => JSON.parse(readFileSync(process.env.TINYWEBUI_MCP, 'utf8')).mcpServers;

test('declined: nothing is written', async () => {
  const events = await converse({ action: 'add', name: 'gh', url: 'http://127.0.0.1:9/mcp', headers: { Authorization: `Bearer ${SECRET}` } }, 'deny');
  assert.ok(events.some((e) => e.type === 'approval'), 'asked although toolApproval is off');
  assert.match(events.find((e) => e.type === 'tool_result').result, /^The user declined/);
  assert.deepEqual(file(), {});
});

test('listing needs no approval', async () => {
  const events = await converse({ action: 'list' }, 'deny');
  assert.ok(!events.some((e) => e.type === 'approval'));
  assert.deepEqual(JSON.parse(events.find((e) => e.type === 'tool_result').result).servers, []);
});

test('approved: saved at once, the secret never comes back, the hub follows when the reply ends', async () => {
  const events = await converse({ action: 'add', name: 'gh', url: 'http://127.0.0.1:9/mcp', headers: { Authorization: `Bearer ${SECRET}` } }, 'allow');
  const result = events.find((e) => e.type === 'tool_result').result;
  assert.equal(JSON.parse(result).saved, true);
  assert.ok(!result.includes(SECRET), 'the key is not in the tool result');
  // What the model wrote is stored and shown with its call: the approval card, the
  // call itself and the saved assistant message ('done'). Nothing that comes back
  // from the tool, or anywhere else, carries it.
  const WRITTEN = ['tool_call', 'approval', 'done'];
  const leaks = events.filter((e) => !WRITTEN.includes(e.type) && JSON.stringify(e).includes(SECRET));
  assert.deepEqual(leaks.map((e) => e.type), [], 'nor in anything else the stream sends');
  assert.equal(file().gh.headers.Authorization, `Bearer ${SECRET}`);

  const deadline = Date.now() + 5000;
  while (!(await servers()).includes('gh')) {
    if (Date.now() > deadline) assert.fail('the hub did not reconnect after the reply');
    await new Promise((r) => setTimeout(r, 50));
  }
});

test('the key is not in the page-facing config or the tools panel either', async () => {
  const panel = JSON.stringify(await (await fetch(`${base}/api/tools`)).json());
  assert.ok(!panel.includes(SECRET));
});
