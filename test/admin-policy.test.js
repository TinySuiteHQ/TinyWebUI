// The admin policy editor: the user role's features and models, what users may
// customise, and how new users start. Decisions land in the config file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'tinywebui-policy-'));
const configFile = join(dir, 'tinywebui.config.json');
writeFileSync(configFile, JSON.stringify({ baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'a', models: [{ id: 'a' }, { id: 'b' }] }));
writeFileSync(join(dir, 'mcp.json'), '{ "mcpServers": {} }\n');
const { start } = await import('../src/server.js');
const srv = await start({
  port: 0, host: '127.0.0.1', configFile, dbPath: join(dir, 'p.db'),
  config: { authMode: 'trusted-header', trustedProxyCidrs: ['127.0.0.1/32'], access: { bootstrapAdmins: ['sub-root'] } }
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

// `access` is set in code here (bootstrapAdmins), which locks the whole key;
// the file-backed case is covered by the next test's fresh server.
test('policy is readable by admins only, and locked when access is set in code', async () => {
  assert.equal((await user('/api/admin/policy')).status, 403);
  const p = (await root('/api/admin/policy')).data;
  assert.deepEqual(p.models, ['a', 'b']);
  assert.equal(p.locked, true);
  const r = await root('/api/admin/policy', { method: 'POST', body: { newUsers: 'pending' } });
  assert.equal(r.status, 409);
});

test('with access in the file, an admin edits the user role and it is written back', async () => {
  const d2 = mkdtempSync(join(tmpdir(), 'tinywebui-policy2-'));
  const file = join(d2, 'tinywebui.config.json');
  writeFileSync(file, JSON.stringify({ models: [{ id: 'a' }, { id: 'b' }], model: 'a', access: { bootstrapAdmins: ['sub-root'] } }));
  writeFileSync(join(d2, 'mcp.json'), '{ "mcpServers": {} }\n');
  const s2 = await start({
    port: 0, host: '127.0.0.1', configFile: file, dbPath: join(d2, 'p.db'),
    config: { authMode: 'trusted-header', trustedProxyCidrs: ['127.0.0.1/32'], baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k' }
  });
  try {
    const call = async (id, path, body) => {
      const res = await fetch(`http://127.0.0.1:${s2.address().port}${path}`, {
        method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-tinysuite-user-id': id }, body: body && JSON.stringify(body)
      });
      return { status: res.status, data: await res.json().catch(() => null) };
    };
    assert.equal((await call('sub-root', '/api/admin/policy')).data.locked, false);
    const ok = await call('sub-root', '/api/admin/policy', { features: ['chat'], models: ['a'], customize: ['theme', 'instructions'], newUsers: 'pending' });
    assert.equal(ok.status, 200);
    const saved = JSON.parse(readFileSync(file, 'utf8')).access;
    assert.deepEqual(saved.roles.user, { features: ['chat'], models: ['a'] });
    assert.deepEqual([saved.newUsers, saved.customize, saved.bootstrapAdmins], ['pending', ['theme', 'instructions'], ['sub-root']]);
    const bad = await call('sub-root', '/api/admin/policy', { models: ['nope'] });
    assert.equal(bad.status, 400);
    assert.match(bad.data.error, /nope/);
  } finally { await s2.shutdown(); }
});
