// Per-user identity for shared MCP servers (access/mcp_identity.ts and the
// per-user connections in McpHub): who a call goes out as, checked on the
// wire against a real streamable-HTTP MCP server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { McpHub, POOL_IDLE_MS } from '../src/mcp.ts';
import { identityProblems, claimValue, DISCOVERY_PRINCIPAL } from '../src/access/mcp_identity.ts';
import { createConfigSource } from '../src/config/config.ts';
import { Store } from '../src/store/index.ts';
import { runChat } from '../src/chat/llm.ts';
import { startMcpHttpServer } from './mcp-http-fixture.js';

const as = (userId) => ({ store: null, chatId: 'c', budget: 8000, unattended: false, askUser: null, userId });
// Stands in for server.ts's resolver: approved users only, by id.
const principal = (userId) => (userId && !userId.startsWith('banned') ? `user:${userId}` : null);

async function boundHub(t, { claim } = {}) {
  const fixture = await startMcpHttpServer();
  const hub = new McpHub({ mem: { url: fixture.url, identity: { header: 'X-User', ...(claim ? { claim } : {}) } } }, { principal });
  await hub.connect();
  t.after(async () => { await hub.close(); await fixture.close(); });
  return { hub, fixture };
}

/* ---------- configuration ---------- */

test('identity is refused on a local server, a reserved header, or a clashing static header', () => {
  assert.match(identityProblems('m', { command: 'x', identity: { header: 'X-User' } }).join(), /needs a remote/);
  assert.match(identityProblems('m', { url: 'http://h/mcp', identity: { header: 'Authorization' } }).join(), /connection itself uses it/);
  assert.match(identityProblems('m', { url: 'http://h/mcp', identity: { header: 'Mcp-Session-Id' } }).join(), /connection itself uses it/);
  assert.match(identityProblems('m', { url: 'http://h/mcp', headers: { 'x-user': 'me' }, identity: { header: 'X-User' } }).join(), /fixed value stand in for the user/);
  assert.match(identityProblems('m', { url: 'http://h/mcp', identity: { header: 'X-User', claim: 'name' } }).join(), /claim must be one of/);
  assert.match(identityProblems('m', { url: 'http://h/mcp', identity: { header: 'X-User', extra: 1 } }).join(), /not a known setting/);
  assert.match(identityProblems('m', { url: 'http://h/mcp', identity: { header: 'bad header' } }).join(), /HTTP header name/);
  assert.deepEqual(identityProblems('m', { url: 'http://h/mcp', identity: { header: 'X-TinyContext-User-Id', claim: 'email' } }), []);
  assert.deepEqual(identityProblems('m', { command: 'x' }), [], 'no identity, nothing to check');
});

test('mcp.json with a bad identity is never written', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tinywebui-identity-'));
  const source = createConfigSource({ configFile: join(dir, 'tinywebui.config.json') });
  writeFileSync(join(dir, 'mcp.json'), '{"mcpServers":{}}');
  const bad = JSON.stringify({ mcpServers: { m: { command: 'uvx', identity: { header: 'X-User' } } } });
  assert.throws(() => source.saveMcpFile(bad), /needs a remote/);
  assert.equal(source.readMcpFile(), '{"mcpServers":{}}', 'the file is untouched');
  source.saveMcpFile(JSON.stringify({ mcpServers: { m: { url: 'http://h/mcp', identity: { header: 'X-User' } } } }));
});

test('a claim maps to the approved user\'s own field and nothing else', () => {
  const user = { id: 'u1', external_id: 'gw-1', email: 'a@x.org', status: 'approved' };
  assert.equal(claimValue(user), 'u1');
  assert.equal(claimValue(user, 'externalId'), 'gw-1');
  assert.equal(claimValue(user, 'email'), 'a@x.org');
  assert.equal(claimValue({ ...user, status: 'pending' }), null, 'not approved: no identity');
  assert.equal(claimValue({ ...user, status: 'disabled' }), null);
  assert.equal(claimValue({ ...user, email: null }, 'email'), null, 'a missing claim refuses rather than guesses');
  assert.equal(claimValue({ ...user, email: 'a@x.org\r\nX-User: bob' }, 'email'), null, 'no header injection');
  assert.equal(claimValue(null), null);
});

test('a hub with a misconfigured identity does not connect that server at all', async (t) => {
  const fixture = await startMcpHttpServer();
  t.after(() => fixture.close());
  const hub = new McpHub({ mem: { url: fixture.url, headers: { 'X-User': 'everyone' }, identity: { header: 'X-User' } } }, { principal });
  await hub.connect();
  t.after(() => hub.close());
  assert.equal(hub.clients.size, 0);
  assert.match(hub.errors.join(), /mem: .*fixed value/);
  assert.equal(fixture.requests.length, 0, 'nothing was sent as a shared caller');
});

/* ---------- on the wire ---------- */

test('discovery runs as the discovery principal and never as a user', async (t) => {
  const { hub, fixture } = await boundHub(t);
  assert.ok(hub.routes.has('mem__whoami'));
  assert.ok(fixture.requests.length > 0);
  assert.ok(fixture.requests.every((r) => r.identity === DISCOVERY_PRINCIPAL.toLowerCase() || r.identity === DISCOVERY_PRINCIPAL));
  assert.equal(fixture.calls.length, 0);
});

test('concurrent users each go out as themselves, on connections of their own', async (t) => {
  const { hub, fixture } = await boundHub(t);
  const users = ['alice', 'bob', 'carol'];
  const results = await Promise.all(
    Array.from({ length: 30 }, (_, i) => users[i % 3]).map(async (u) => [u, await hub.call('mem__whoami', {}, as(u))])
  );
  for (const [u, text] of results) assert.equal(text, `identity=user:${u}`);

  const sessionsOf = (identity) => new Set(fixture.calls.filter((c) => c.identity === identity).map((c) => c.sessionId));
  const seen = users.map((u) => sessionsOf(`user:${u}`));
  for (const s of seen) assert.equal(s.size, 1, 'one connection per user, however many calls');
  assert.equal(new Set(seen.flatMap((s) => [...s])).size, 3, 'and no two users share one');
  const discovery = fixture.requests.find((r) => r.identity === DISCOVERY_PRINCIPAL)?.sessionId;
  assert.ok(seen.every((s) => !s.has(discovery)), 'no user call rides the discovery connection');
});

test('a call with no one to act for is refused before anything is sent', async (t) => {
  const { hub, fixture } = await boundHub(t);
  const before = fixture.requests.length;
  assert.match(await hub.call('mem__whoami', {}, as(null)), /no signed-in user/);
  assert.match(await hub.call('mem__whoami', {}, as(undefined)), /no signed-in user/);
  assert.match(await hub.call('mem__whoami', {}, as('banned-1')), /no signed-in user/);
  assert.match(await hub.call('mem__whoami', {}, undefined), /no signed-in user/);
  assert.equal(fixture.requests.length, before);
  assert.equal(fixture.calls.length, 0);
});

test('arguments cannot name another user', async (t) => {
  const { hub } = await boundHub(t);
  const text = await hub.call('mem__whoami', { userId: 'bob', 'X-User': 'bob', identity: 'user:bob' }, as('alice'));
  assert.equal(text, 'identity=user:alice');
});

test('a hub without a principal resolver refuses every per-user call', async (t) => {
  const fixture = await startMcpHttpServer();
  const hub = new McpHub({ mem: { url: fixture.url, identity: { header: 'X-User' } } });
  await hub.connect();
  t.after(async () => { await hub.close(); await fixture.close(); });
  assert.match(await hub.call('mem__whoami', {}, as('alice')), /no signed-in user/);
});

test('an ordinary server keeps one shared connection with no identity header', async (t) => {
  const fixture = await startMcpHttpServer();
  const hub = new McpHub({ plain: { url: fixture.url } }, { principal });
  await hub.connect();
  t.after(async () => { await hub.close(); await fixture.close(); });
  assert.equal(await hub.call('plain__whoami', {}, as('alice')), 'identity=null');
  assert.equal(await hub.call('plain__whoami', {}, as('bob')), 'identity=null');
  assert.equal(new Set(fixture.calls.map((c) => c.sessionId)).size, 1);
  assert.equal(hub.pools.size, 0);
});

test('a user\'s connection the server dropped is replaced, still as that user', async (t) => {
  const { hub, fixture } = await boundHub(t);
  assert.equal(await hub.call('mem__whoami', {}, as('alice')), 'identity=user:alice');
  const first = fixture.calls.at(-1).sessionId;
  await fixture.dropSession(first);
  // The server answers 404 for the forgotten session: the call never ran,
  // so it is sent again at once on a fresh connection.
  assert.equal(await hub.call('mem__whoami', {}, as('alice')), 'identity=user:alice');
  assert.notEqual(fixture.calls.at(-1).sessionId, first);
});

test('a non-idempotent call on a forgotten session is still repeated: it never ran', async (t) => {
  const fixture = await startMcpHttpServer({
    setup: (server, { calls, header }) => server.registerTool('write', {}, async (extra) => {
      calls.push({ tool: 'write', identity: extra.requestInfo?.headers?.[header] ?? null, sessionId: extra.sessionId });
      return { content: [{ type: 'text', text: 'written' }] };
    })
  });
  const hub = new McpHub({ mem: { url: fixture.url, identity: { header: 'X-User' } } }, { principal });
  await hub.connect();
  t.after(async () => { await hub.close(); await fixture.close(); });
  assert.equal(await hub.call('mem__write', {}, as('alice')), 'written');
  await fixture.dropSession(fixture.calls.at(-1).sessionId);
  assert.equal(await hub.call('mem__write', {}, as('alice')), 'written');
  assert.equal(fixture.calls.filter((c) => c.tool === 'write').length, 2, 'once per call, never twice');
});

test('idle per-user connections are closed by the sweep and reopen on demand', async (t) => {
  const { hub, fixture } = await boundHub(t);
  await hub.call('mem__whoami', {}, as('alice'));
  assert.equal(hub.pools.get('mem').size, 1);
  hub.sweep(Date.now() + POOL_IDLE_MS + 1);
  assert.equal(hub.pools.get('mem').size, 0);
  assert.equal(await hub.call('mem__whoami', {}, as('alice')), 'identity=user:alice');
  assert.equal(new Set(fixture.calls.map((c) => c.sessionId)).size, 2);
});

test('inventory names the identity header and claim, never a value', async (t) => {
  const { hub } = await boundHub(t, { claim: 'email' });
  await hub.call('mem__whoami', {}, as('alice'));
  const row = hub.inventory([]).servers.find((s) => s.name === 'mem');
  assert.deepEqual(row.identity, { header: 'X-User', claim: 'email' });
  assert.doesNotMatch(JSON.stringify(hub.inventory([])), /user:alice/);
});

/* ---------- through a turn ---------- */

async function scripted(replies) {
  let n = 0;
  const srv = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const reply = replies[Math.min(n++, replies.length - 1)];
      const delta = reply.calls
        ? { tool_calls: reply.calls.map(([name, args], index) => ({ index, id: `c${n}_${index}`, type: 'function', function: { name, arguments: args } })) }
        : { content: reply.text };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`);
      res.end();
    });
  });
  const port = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
  return { baseUrl: `http://127.0.0.1:${port}/v1`, close: () => srv.close() };
}

test('a turn acts as the chat\'s owner, whatever the model writes', async (t) => {
  const { hub } = await boundHub(t);
  const provider = await scripted([{ calls: [['mem__whoami', '{"userId":"bob"}']] }, { text: 'done' }]);
  t.after(() => provider.close());
  const store = new Store(':memory:');
  const { user } = store.users.provision({ externalId: 'gw-alice', role: 'user', status: 'approved' });
  const chat = store.chats.create({ title: 't' }, user.id);
  store.messages.add(chat.id, { role: 'user', content: 'who am I?' });
  await runChat({
    cfg: { baseUrl: provider.baseUrl, apiKey: 'k', model: 'm', systemPrompt: 's', maxToolRounds: 3, toolApproval: 'off' },
    chatId: chat.id, store, tools: hub.tools, hub, emit: () => {}, signal: new AbortController().signal
  });
  const result = store.messages.list(chat.id).find((m) => m.role === 'tool');
  assert.equal(result.content.split('\n')[0], `identity=user:${user.id}`);
  store.close();
});
