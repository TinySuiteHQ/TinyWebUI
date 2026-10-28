// The Integrations panel API (routes/integrations.ts) and the manifest
// contract (management.ts): what each person may see and do, checked against
// real MCP servers on loopback.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
// The SDK's tool schemas must be zod, which the SDK itself depends on.
import { z } from 'zod';

import { parseManifest, viewUri, detailUri, actionArgs, shapeViewData, MANIFEST_MIME } from '../src/management.ts';
import { startMcpHttpServer } from './mcp-http-fixture.js';

/* ---------- a server that offers a management page ---------- */

const MEMORIES = {
  id: 'memories', title: 'Memories', kind: 'table', scope: 'user', resource: 'fx://manage/views/memories/{params}',
  pageSize: 2, rowKey: 'id', params: [{ name: 'q', label: 'Search', type: 'text', maxLength: 50 }],
  columns: [{ key: 'content', label: 'Memory' }, { key: 'created_at', label: 'Saved', format: 'datetime' }],
  detail: { resource: 'fx://manage/items/{id}' },
  actions: [
    { id: 'delete', label: 'Delete', tool: 'delete_memory', args: { memory_id: '$row.id' }, destructive: true, confirm: 'Delete?' },
    { id: 'edit', label: 'Edit', tool: 'update_memory', input: { label: 'Memory', initial: 'content', maxLength: 100 },
      args: { memory_id: '$row.id', content: '$input' } }
  ]
};
const SERVICE = { id: 'service', title: 'Service', kind: 'stats', scope: 'instance', resource: 'fx://manage/views/service/{params}' };
const manifestOf = (views, extra = {}) => ({ contract: 'tinysuite.manage/1', id: 'fx', title: 'Fixture', icon: 'memory', version: '1', views, ...extra });

/** A memory server keyed by the identity header, with a management page. */
function memoryServer({ manifest = manifestOf([MEMORIES, SERVICE]) } = {}) {
  const stores = new Map(); // identity -> Map(id -> { id, content, created_at })
  let next = 1;
  const storeOf = (extra, header) => {
    const who = extra.requestInfo?.headers?.[header] ?? 'shared';
    if (!stores.has(who)) stores.set(who, new Map());
    return stores.get(who);
  };
  const seed = (who, ...contents) => {
    if (!stores.has(who)) stores.set(who, new Map());
    for (const content of contents) { const id = `m${next++}`; stores.get(who).set(id, { id, content, created_at: '2026-10-28T10:00:00Z' }); }
  };
  const setup = (server, { header }) => {
    const text = (uri, value) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(value) }] });
    server.registerResource('manifest', 'fx://manage/manifest', { mimeType: MANIFEST_MIME },
      async (uri) => text(uri, typeof manifest === 'function' ? manifest() : manifest));
    server.registerResource('memories', new ResourceTemplate('fx://manage/views/memories/{params}', { list: undefined }), {},
      async (uri, { params }, extra) => {
        const query = new URLSearchParams(params === '-' ? '' : decodeURIComponent(params));
        const all = [...storeOf(extra, header).values()].filter((m) => m.content.includes(query.get('q') || ''));
        const offset = Number(query.get('offset') || 0), limit = Number(query.get('limit') || 50);
        return text(uri, { rows: all.slice(offset, offset + limit).map((m) => ({ ...m, secret: { nested: true } })), total: all.length, hasMore: offset + limit < all.length });
      });
    server.registerResource('item', new ResourceTemplate('fx://manage/items/{id}', { list: undefined }), {},
      async (uri, { id }, extra) => {
        const m = storeOf(extra, header).get(decodeURIComponent(id));
        if (!m) throw new Error('no such memory');
        return text(uri, { fields: [{ label: 'Memory', value: m.content, format: 'multiline' }], row: m });
      });
    server.registerResource('service', new ResourceTemplate('fx://manage/views/service/{params}', { list: undefined }), {},
      async (uri) => text(uri, { items: [{ label: 'Stores', value: stores.size }] }));
    server.registerTool('delete_memory', { inputSchema: { memory_id: z.string() } }, async ({ memory_id }, extra) => {
      const deleted = storeOf(extra, header).delete(memory_id);
      return deleted ? { content: [{ type: 'text', text: 'deleted' }] } : { content: [{ type: 'text', text: 'no such memory' }], isError: true };
    });
    server.registerTool('update_memory', { inputSchema: { memory_id: z.string(), content: z.string() } }, async ({ memory_id, content }, extra) => {
      const m = storeOf(extra, header).get(memory_id);
      if (!m) return { content: [{ type: 'text', text: 'no such memory' }], isError: true };
      m.content = content;
      return { content: [{ type: 'text', text: 'updated' }] };
    });
  };
  return { stores, seed, setup };
}


async function deployment(t, { servers, authMode = 'trusted-header' }) {
  const dir = mkdtempSync(join(tmpdir(), 'tinywebui-integrations-'));
  const { start } = await import('../src/server.ts');
  const srv = await start({
    port: 0, host: '127.0.0.1', configFile: false, watch: false, mcpServers: servers, dbPath: join(dir, 'db.sqlite'),
    config: { authMode, trustedProxyCidrs: ['127.0.0.1/32', '::1/128'], baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'm' }
  });
  t.after(() => srv.shutdown());
  const base = `http://127.0.0.1:${srv.address().port}`;
  const as = (who) => async (path, { method = 'GET', body } = {}) => {
    const headers = { 'content-type': 'application/json' };
    if (who?.id) headers['x-tinysuite-user-id'] = who.id;
    if (who?.role) headers['x-tinysuite-role'] = who.role;
    const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  return { as };
}

/* ---------- the contract ---------- */

const TOOLS = new Set(['delete_memory', 'update_memory']);

test('a valid manifest parses, and the browser never sees tool names or URIs', () => {
  const m = parseManifest(JSON.stringify(manifestOf([MEMORIES, SERVICE])), TOOLS);
  assert.equal(m.views.length, 2);
  assert.equal(m.views[0].actions[0].tool, 'delete_memory');
});

test('a manifest is refused for anything outside the contract', () => {
  const bad = (views, extra, re) => assert.throws(() => parseManifest(manifestOf(views, extra), TOOLS), re);
  bad([MEMORIES], { contract: 'tinysuite.manage/2' }, /supports no other version/);
  bad([{ ...MEMORIES, actions: [{ ...MEMORIES.actions[0], tool: 'drop_database' }] }], {}, /not one of this server's tools/);
  bad([{ ...MEMORIES, resource: 'https://evil.example/{params}' }], {}, /not a web or file address/);
  bad([{ ...MEMORIES, resource: 'fx://no-params' }], {}, /\{params\} exactly once/);
  bad([{ ...MEMORIES, detail: { resource: 'file:///etc/{id}' } }], {}, /not a web or file address/);
  bad([{ ...MEMORIES, actions: [{ ...MEMORIES.actions[0], args: { memory_id: '$env.HOME' } }] }], {}, /unknown reference/);
  bad([{ ...MEMORIES, actions: [{ ...MEMORIES.actions[0], target: 'view' }] }], {}, /not a usable \$row/);
  bad([{ ...SERVICE, actions: [MEMORIES.actions[0]] }], {}, /only table views/);
  bad(Array.from({ length: 13 }, (_, i) => ({ ...SERVICE, id: `v${i}` })), {}, /at most 12/);
  bad([{ ...MEMORIES, title: 'x\u0000' }], {}, /views\[0\]\.title/);
  bad([{ ...MEMORIES, params: [{ name: 'offset', label: 'x', type: 'text' }] }], {}, /reserved for paging/);
  assert.equal(parseManifest(manifestOf([], { icon: '<img src=x>' }), TOOLS).icon, 'plug', 'unknown icons are drawn as a plug');
});

test('view requests carry only declared, valid parameters', () => {
  const view = parseManifest(manifestOf([MEMORIES]), TOOLS).views[0];
  const uri = viewUri(view, new URLSearchParams({ q: 'tea/../x', offset: '-5', limit: '999', owner: 'bob' }));
  const qs = decodeURIComponent(uri.split('/').pop());
  assert.deepEqual(Object.fromEntries(new URLSearchParams(qs)), { q: 'tea/../x', offset: '0', limit: '2' });
  assert.ok(uri.startsWith('fx://manage/views/memories/') && !uri.slice('fx://manage/views/memories/'.length).includes('/'));
  assert.throws(() => viewUri(view, new URLSearchParams({ q: 'x'.repeat(51) })), /too long/);
  assert.match(detailUri(view, 'a/b'), /items\/a%2Fb$/);
  assert.throws(() => detailUri(view, 'x\n'), /invalid id/);
});

test('action arguments come only from the binding', () => {
  const [del, edit] = parseManifest(manifestOf([MEMORIES]), TOOLS).views[0].actions;
  assert.deepEqual(actionArgs(del, { id: 'm1', other: 'x' }, 'ignored'), { memory_id: 'm1' });
  assert.throws(() => actionArgs(del, { id: { $ne: 1 } }), /no usable "id"/);
  assert.throws(() => actionArgs(edit, { id: 'm1' }, ''), /1-100 characters/);
  assert.deepEqual(actionArgs(edit, { id: 'm1' }, 'new'), { memory_id: 'm1', content: 'new' });
});

test('view data is cut down to declared scalar fields', () => {
  const view = parseManifest(manifestOf([MEMORIES]), TOOLS).views[0];
  const shaped = shapeViewData(view, { rows: [{ id: 'm1', content: 'x', created_at: 't', secret: { a: 1 }, html: '<b>' }], total: 1 });
  assert.deepEqual(shaped.rows, [{ content: 'x', created_at: 't', id: 'm1' }]);
  assert.equal(shapeViewData(view, 'garbage').rows.length, 0);
});

/* ---------- through the API ---------- */

test('each person sees and changes only their own data on a per-user server', async (t) => {
  const mem = memoryServer();
  mem.seed('alice', 'alice likes tea', 'alice works remote', 'alice has a cat');
  mem.seed('bob', 'bob likes coffee');
  const fixture = await startMcpHttpServer({ header: 'x-user', setup: mem.setup });
  t.after(() => fixture.close());
  const { as } = await deployment(t, { servers: { mem: { url: fixture.url, identity: { header: 'X-User', claim: 'externalId' } } } });
  const alice = as({ id: 'alice' }), bob = as({ id: 'bob' }), admin = as({ id: 'root', role: 'admin' });

  const list = await alice('/api/integrations');
  assert.equal(list.status, 200);
  const row = list.data.servers.find((s) => s.name === 'mem');
  assert.equal(row.perUser, true);
  assert.deepEqual(row.manifest.views.map((v) => v.id), ['memories'], 'no instance view for a user');
  assert.ok(!JSON.stringify(list.data).includes('delete_memory') && !JSON.stringify(list.data).includes('fx://'));

  const page = await alice('/api/integrations/mem/views/memories');
  assert.deepEqual(page.data.rows.map((r) => r.content), ['alice likes tea', 'alice works remote']);
  assert.deepEqual([page.data.total, page.data.hasMore], [3, true]);
  assert.ok(!('secret' in page.data.rows[0]));
  const next = await alice('/api/integrations/mem/views/memories?offset=2');
  assert.deepEqual(next.data.rows.map((r) => r.content), ['alice has a cat']);
  assert.deepEqual((await alice('/api/integrations/mem/views/memories?q=cat')).data.rows.map((r) => r.content), ['alice has a cat']);
  assert.deepEqual((await bob('/api/integrations/mem/views/memories')).data.rows.map((r) => r.content), ['bob likes coffee']);

  const bobsId = [...mem.stores.get('bob').keys()][0];
  assert.equal((await alice(`/api/integrations/mem/views/memories/items/${bobsId}`)).status, 502, 'another user\'s item is not found');
  const aliceId = page.data.rows[0].id;
  assert.equal((await alice(`/api/integrations/mem/views/memories/items/${aliceId}`)).data.fields[0].value, 'alice likes tea');

  const unconfirmed = await alice('/api/integrations/mem/views/memories/actions/delete', { method: 'POST', body: { row: { id: aliceId } } });
  assert.deepEqual([unconfirmed.status, unconfirmed.data.error], [400, 'confirm_required']);
  assert.ok(mem.stores.get('alice').has(aliceId));

  const forged = await alice('/api/integrations/mem/views/memories/actions/delete', { method: 'POST', body: { row: { id: bobsId }, confirm: true } });
  assert.equal(forged.status, 422, 'a forged row id still runs as alice, so it finds nothing');
  assert.ok(mem.stores.get('bob').has(bobsId));

  const done = await alice('/api/integrations/mem/views/memories/actions/delete', { method: 'POST', body: { row: { id: aliceId }, confirm: true } });
  assert.deepEqual([done.status, done.data.ok], [200, true]);
  assert.ok(!mem.stores.get('alice').has(aliceId));

  const edited = await alice('/api/integrations/mem/views/memories/actions/edit', { method: 'POST', body: { row: { id: page.data.rows[1].id }, input: 'alice works hybrid' } });
  assert.equal(edited.status, 200);
  assert.equal(mem.stores.get('alice').get(page.data.rows[1].id).content, 'alice works hybrid');

  assert.equal((await alice('/api/integrations/mem/views/service')).status, 404, 'a user cannot even find the instance view');
  const adminList = await admin('/api/integrations');
  assert.deepEqual(adminList.data.servers[0].manifest.views.map((v) => v.id).sort(), ['memories', 'service']);
  assert.equal((await admin('/api/integrations/mem/views/service')).data.items[0].label, 'Stores');
  assert.equal(mem.stores.has('urn:tinywebui:discovery'), false, 'no user data was ever kept under the discovery identity');
});

test('a server everyone shares has no per-person view in a multi-user deployment', async (t) => {
  const mem = memoryServer();
  mem.seed('shared', 'everyone\'s memory');
  const fixture = await startMcpHttpServer({ header: 'x-user', setup: mem.setup });
  t.after(() => fixture.close());
  const { as } = await deployment(t, { servers: { mem: { url: fixture.url } } });
  for (const who of [{ id: 'alice' }, { id: 'root', role: 'admin' }]) {
    const list = await as(who)('/api/integrations');
    const view = list.data.servers[0].manifest.views.find((v) => v.id === 'memories');
    assert.equal(view.available, false);
    assert.match(view.reason, /shared by everyone/);
    assert.equal((await as(who)('/api/integrations/mem/views/memories')).status, 403);
  }
});

test('a no-login install is one person who sees every view', async (t) => {
  const mem = memoryServer();
  mem.seed('shared', 'my memory');
  const fixture = await startMcpHttpServer({ header: 'x-user', setup: mem.setup });
  t.after(() => fixture.close());
  const { as } = await deployment(t, { authMode: 'local', servers: { mem: { url: fixture.url } } });
  const me = as(null);
  const views = (await me('/api/integrations')).data.servers[0].manifest.views;
  assert.deepEqual(views.map((v) => [v.id, v.available]), [['memories', true], ['service', true]]);
  assert.deepEqual((await me('/api/integrations/mem/views/memories')).data.rows.map((r) => r.content), ['my memory']);
});

test('servers without a page, with a bad manifest, or offline still list cleanly', async (t) => {
  const plain = await startMcpHttpServer();
  const evil = memoryServer({ manifest: manifestOf([{ ...MEMORIES, actions: [{ ...MEMORIES.actions[0], tool: 'rm_rf' }] }]) });
  const evilFixture = await startMcpHttpServer({ header: 'x-user', setup: evil.setup });
  t.after(() => Promise.all([plain.close(), evilFixture.close()]));
  const { as } = await deployment(t, { servers: {
    plain: { url: plain.url },
    evil: { url: evilFixture.url, identity: { header: 'X-User' } },
    gone: { url: 'http://127.0.0.1:9/mcp' }
  } });
  const admin = as({ id: 'root', role: 'admin' });
  const byName = Object.fromEntries((await admin('/api/integrations')).data.servers.map((s) => [s.name, s]));
  assert.deepEqual([byName.plain.status, byName.plain.managed], ['ok', false]);
  assert.match(byName.evil.manageError, /invalid manifest: .*not one of this server's tools/);
  assert.equal(byName.gone.status, 'error');
  assert.equal((await admin('/api/integrations/plain/views/x')).status, 404);
  assert.equal((await as({ id: 'alice' })('/api/integrations')).data.servers.find((s) => s.name === 'gone').error, null,
    'why a server failed is for admins');
});
