// The files are the record: admin decisions and settings changes land in
// config.json, survive a fresh database, and code-declared things hold.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'tinywebui-writeback-'));
const configFile = join(dir, 'tinywebui.config.json');
writeFileSync(configFile, '{}\n');
writeFileSync(join(dir, 'mcp.json'), '{ "mcpServers": {} }\n');
const readCfg = () => JSON.parse(readFileSync(configFile, 'utf8'));

const { start } = await import('../src/server.js');
const code = {
  authMode: 'trusted-header', trustedProxyCidrs: ['127.0.0.1/32'],
  baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k',
  access: { bootstrapAdmins: ['sub-root'], users: { 'sub-pinned': { status: 'approved' } } }
};
const boot = (db) => start({ port: 0, host: '127.0.0.1', configFile, config: code, dbPath: join(dir, db) });

const client = (srv) => (who) => async (path, { method = 'GET', body } = {}) => {
  const headers = { 'content-type': 'application/json', 'x-tinysuite-user-id': who.id };
  if (who.role) headers['x-tinysuite-role'] = who.role;
  const res = await fetch(`http://127.0.0.1:${srv.address().port}${path}`, { method, headers, body: body && JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => null) };
};

let srv = await boot('a.db');
let as = client(srv);
test.after(() => srv.shutdown());

test('a bootstrap admin is admin with no role header, and cannot be demoted', async () => {
  const root = as({ id: 'sub-root' });
  const me = (await root('/api/auth/me')).data;
  assert.equal(me.isAdmin, true);
  const r = await root(`/api/admin/users/${me.user.id}`, { method: 'PATCH', body: { role: 'user' } });
  assert.equal(r.status, 400);
  const other = as({ id: 'sub-other-admin', role: 'admin' });
  assert.equal((await other(`/api/admin/users/${me.user.id}`, { method: 'PATCH', body: { status: 'disabled' } })).status, 400);
  assert.match((await root('/api/admin/users')).data.fingerprint, /^[0-9a-f]{16}$/);
});

test('settings changes are written to config.json', async () => {
  const root = as({ id: 'sub-root' });
  assert.equal((await root('/api/config', { method: 'POST', body: { systemPrompt: 'from the UI' } })).status, 200);
  assert.equal(readCfg().systemPrompt, 'from the UI');
  const refused = await root('/api/config', { method: 'POST', body: { authMode: 'none' } });
  assert.equal(refused.status, 409, 'file-only keys stay file-only, even for admins');
});

test('an admin decision lands in access.users and survives a fresh database', async () => {
  const root = as({ id: 'sub-root' });
  const victim = as({ id: 'sub-victim' });
  const id = (await victim('/api/auth/me')).data.user.id;
  assert.equal((await root(`/api/admin/users/${id}`, { method: 'PATCH', body: { status: 'disabled', role: 'admin' } })).status, 200);
  assert.deepEqual(readCfg().access.users['sub-victim'], { status: 'disabled', role: 'admin' });
  assert.equal((await victim('/api/chats')).status, 403);

  // New process, new empty database, same files: the ban holds.
  await srv.shutdown();
  srv = await boot('b.db');
  as = client(srv);
  const again = await as({ id: 'sub-victim' })('/api/chats');
  assert.equal(again.status, 403);
  assert.equal(again.data.error, 'disabled');
});

test('users pinned in code cannot be changed from the UI', async () => {
  const pinned = as({ id: 'sub-pinned' });
  const id = (await pinned('/api/auth/me')).data.user.id;
  const r = await as({ id: 'sub-root' })(`/api/admin/users/${id}`, { method: 'PATCH', body: { status: 'disabled' } });
  assert.equal(r.status, 409);
  const listed = (await as({ id: 'sub-root' })('/api/admin/users')).data.users.find((u) => u.id === id);
  assert.equal(listed.pinnedInCode, 'access.users');
});

test('the file outranks the gateway role header', async () => {
  // sub-victim was made admin in the file above; a header saying "user" loses.
  const cfg = readCfg();
  cfg.access.users['sub-victim'] = { role: 'user', status: 'approved' };
  writeFileSync(configFile, JSON.stringify(cfg, null, 2));
  await srv.shutdown();
  srv = await boot('b.db');
  as = client(srv);
  const me = (await as({ id: 'sub-victim', role: 'admin' })('/api/auth/me')).data;
  assert.equal(me.user.role, 'user');
  assert.equal(me.user.status, 'approved');
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
