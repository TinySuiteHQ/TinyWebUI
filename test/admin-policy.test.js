// The admin policy editor: roles (built-in and custom), what each may do, and
// how new people start. Decisions land in the config file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'tinywebui-policy-'));
const configFile = join(dir, 'tinywebui.config.json');
writeFileSync(configFile, JSON.stringify({ baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'a', models: [{ id: 'a' }, { id: 'b' }] }));
writeFileSync(join(dir, 'mcp.json'), '{ "mcpServers": {} }\n');
const { start } = await import('../src/server.ts');
const srv = await start({
  port: 0, host: '127.0.0.1', configFile, dbPath: join(dir, 'p.db'),
  config: { authMode: 'trusted-header', trustedProxyCidrs: ['127.0.0.1/32'], access: { bootstrapAdmins: ['sub-root'], newUsers: 'approved' } }
});
test.after(() => srv.shutdown());
const as = (id) => async (path, { method = 'GET', body } = {}) => {
  const res = await fetch(`http://127.0.0.1:${srv.address().port}${path}`, {
    method, headers: { 'content-type': 'application/json', 'x-tinysuite-user-id': id }, body: body && JSON.stringify(body)
  });
  return { status: res.status, data: await res.json().catch(() => null) };
};
const root = as('sub-root');
const user = as('sub-user');

/** A server whose `access` lives in the file, so admins may change it. */
async function fileBacked(t, access) {
  const d = mkdtempSync(join(tmpdir(), 'tinywebui-policy2-'));
  const file = join(d, 'tinywebui.config.json');
  writeFileSync(file, JSON.stringify({ models: [{ id: 'a' }, { id: 'b' }], model: 'a', access: { bootstrapAdmins: ['sub-root'], ...access } }));
  writeFileSync(join(d, 'mcp.json'), '{ "mcpServers": {} }\n');
  const s = await start({
    port: 0, host: '127.0.0.1', configFile: file, dbPath: join(d, 'p.db'),
    config: { authMode: 'trusted-header', trustedProxyCidrs: ['127.0.0.1/32'], baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k' }
  });
  t.after(() => s.shutdown());
  const call = (id) => async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(`http://127.0.0.1:${s.address().port}${path}`, {
      method, headers: { 'content-type': 'application/json', 'x-tinysuite-user-id': id }, body: body && JSON.stringify(body)
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  return { call, saved: () => JSON.parse(readFileSync(file, 'utf8')).access };
}

// `access` is set in code here (bootstrapAdmins), which locks the whole key;
// the file-backed cases below each get a fresh server.
test('policy is readable by admins only, and locked when access is set in code', async () => {
  assert.equal((await user('/api/admin/policy')).status, 403);
  const p = (await root('/api/admin/policy')).data;
  assert.deepEqual(p.models, ['a', 'b']);
  assert.equal(p.locked, true);
  assert.deepEqual(p.roles.map((r) => [r.name, r.builtin, r.fixed]), [['admin', true, true], ['user', true, false]]);
  assert.equal((await root('/api/admin/roles', { method: 'POST', body: { name: 'reviewer' } })).status, 409);
});

test('with access in the file, an admin edits the user role and it is written back', async (t) => {
  const { call, saved } = await fileBacked(t);
  const root = call('sub-root');
  assert.equal((await root('/api/admin/policy')).data.locked, false);
  const ok = await root('/api/admin/roles/user', { method: 'PATCH', body: { features: ['chat'], models: ['a'], customize: ['theme', 'instructions'] } });
  assert.equal(ok.status, 200);
  assert.deepEqual(saved().roles.user, { features: ['chat'], models: ['a'], customize: ['theme', 'instructions'] });
  assert.deepEqual(saved().bootstrapAdmins, ['sub-root']);
  assert.equal((await root('/api/admin/policy', { method: 'POST', body: { newUsers: 'approved' } })).status, 404, 'how new people start is the files\' call');
  const bad = await root('/api/admin/roles/user', { method: 'PATCH', body: { models: ['nope'] } });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /nope/);
  assert.equal((await root('/api/admin/roles/admin', { method: 'PATCH', body: { features: ['chat'] } })).status, 400, 'admins keep everything');
  assert.equal((await root('/api/admin/roles/user', { method: 'PATCH', body: { features: ['teleport'] } })).status, 400);
});

test('new people wait for approval, see nothing of the app, and an admin lets them in as a custom role', async (t) => {
  const { call, saved } = await fileBacked(t);
  const root = call('sub-root');
  const gina = call('sub-gina');
  const waiting = (await gina('/api/auth/me')).data;
  assert.equal(waiting.user.status, 'pending');
  assert.deepEqual([waiting.features, waiting.models, waiting.customize, waiting.model], [[], [], [], null], 'a pending person is told nothing about the app');
  assert.equal((await gina('/api/chats')).data.error, 'pending_approval');

  const made = await root('/api/admin/roles', { method: 'POST', body: { name: 'reviewer', features: ['chat', 'search'], models: ['b'], customize: [] } });
  assert.equal(made.status, 201);
  assert.deepEqual(saved().roles.reviewer, { features: ['chat', 'search'], models: ['b'], customize: [] });
  assert.equal((await root('/api/admin/roles', { method: 'POST', body: { name: 'reviewer' } })).status, 409);
  assert.equal((await root('/api/admin/roles', { method: 'POST', body: { name: 'Not OK' } })).status, 400);

  const approved = await root(`/api/admin/users/${waiting.user.id}`, { method: 'PATCH', body: { status: 'approved', role: 'reviewer' } });
  assert.equal(approved.status, 200);
  assert.deepEqual(saved().users['sub-gina'], { status: 'approved', role: 'reviewer' });
  const me = (await gina('/api/auth/me')).data;
  assert.deepEqual([me.user.role, [...me.features].sort(), me.models], ['reviewer', ['chat', 'search'], ['b']]);
  assert.equal((await gina('/api/chats')).status, 200);
  assert.equal((await root(`/api/admin/users/${waiting.user.id}`, { method: 'PATCH', body: { role: 'nobody' } })).status, 400);
  assert.equal((await root('/api/admin/policy')).data.roles.find((r) => r.name === 'reviewer').users, 1);
});

test('deleting a custom role moves its people to the user role; the built-ins stay', async (t) => {
  const { call, saved } = await fileBacked(t, { newUsers: 'approved', roles: { reviewer: { features: ['chat', 'oversight'] } } });
  const root = call('sub-root');
  const rex = call('sub-rex');
  const id = (await rex('/api/auth/me')).data.user.id;
  assert.equal((await root(`/api/admin/users/${id}`, { method: 'PATCH', body: { role: 'reviewer' } })).status, 200);
  assert.ok((await rex('/api/auth/me')).data.features.includes('oversight'));

  for (const name of ['admin', 'user']) assert.equal((await root(`/api/admin/roles/${name}`, { method: 'DELETE' })).status, 400, name);
  assert.equal((await root('/api/admin/roles/ghost', { method: 'DELETE' })).status, 404);
  const gone = await root('/api/admin/roles/reviewer', { method: 'DELETE' });
  assert.equal(gone.status, 200);
  assert.equal(gone.data.moved, 1);
  assert.equal(saved().roles.reviewer, undefined);
  assert.equal(saved().users['sub-rex'].role, 'user');
  const me = (await rex('/api/auth/me')).data;
  assert.equal(me.user.role, 'user');
  assert.ok(!me.features.includes('oversight'));
});
