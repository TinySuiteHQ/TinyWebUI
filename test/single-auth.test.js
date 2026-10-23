// Explicit local mode: one person, no account or login flow.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashPassword } from '../src/access/auth.ts';

const dir = mkdtempSync(join(tmpdir(), 'tinywebui-single-'));
const { start } = await import('../src/server.ts');
const boot = (config) => start({
  port: 0, host: '127.0.0.1', configFile: false, mcpServers: {}, dbPath: join(dir, 'chats.db'),
  config: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'm', ...config }
});
const srv = await boot({ authMode: 'local' });
test.after(() => srv.shutdown());
const base = `http://127.0.0.1:${srv.address().port}`;

const call = async (path, { method = 'GET', body } = {}) => {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, data: await res.json().catch(() => null) };
};

test('local mode opens the workspace with full access and no account management', async () => {
  const me = await call('/api/auth/me');
  assert.equal(me.data.authMode, 'local');
  assert.equal(me.data.user, null);
  assert.equal(me.data.isAdmin, true);
  assert.equal(me.data.needsSetup, false);
  assert.ok(me.data.features.includes('settings'));
  assert.ok(!me.data.features.includes('admin'));
  assert.equal((await call('/api/chats')).status, 200);
  assert.equal((await call('/api/config')).data.readOnly, undefined);
  assert.equal((await call('/api/admin/users')).status, 403);
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { password: 'anything' } })).status, 404);
  assert.equal((await call('/api/auth/logout', { method: 'POST' })).status, 404);
});

test('a legacy single-password config fails closed instead of opening without login', async () => {
  await assert.rejects(boot({ authMode: 'single', authPassword: hashPassword('correct horse') }), /no longer supported/);
});
