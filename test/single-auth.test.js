// Tier 2: just you, behind a password.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashPassword, verifyPassword } from '../src/auth.js';

const dir = mkdtempSync(join(tmpdir(), 'tinywebui-single-'));
const { start } = await import('../src/server.js');
const boot = (config) => start({
  port: 0, host: '127.0.0.1', configFile: false, mcpServers: {}, dbPath: join(dir, 'chats.db'),
  config: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'm', sessionSecret: 's'.repeat(64), ...config }
});
const srv = await boot({ authMode: 'single', authPassword: hashPassword('correct horse') });
test.after(() => srv.shutdown());
const base = `http://127.0.0.1:${srv.address().port}`;

const call = async (path, { method = 'GET', body, cookie } = {}) => {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, data: await res.json().catch(() => null), setCookie: res.headers.get('set-cookie') };
};
const login = async (password) => {
  const r = await call('/api/auth/login', { method: 'POST', body: { password } });
  return { ...r, cookie: r.setCookie?.split(';')[0] };
};

test('hashes verify and never hold the password', () => {
  const h = hashPassword('pw12345678');
  assert.match(h, /^scrypt\$/);
  assert.ok(!h.includes('pw12345678'));
  assert.equal(verifyPassword('pw12345678', h), true);
  assert.equal(verifyPassword('nope', h), false);
  assert.equal(verifyPassword('pw12345678', 'garbage'), false);
});

test('locked until you sign in; the session then works; logout ends it', async () => {
  assert.equal((await call('/api/chats')).status, 401);
  const me = await call('/api/auth/me');
  assert.equal(me.data.authMode, 'single');
  assert.equal(me.data.user, null);

  const { status, cookie } = await login('correct horse');
  assert.equal(status, 200);
  assert.match(cookie, /^tinywebui_session=/);
  assert.equal((await call('/api/chats', { cookie })).status, 200);
  assert.equal((await call('/api/config', { cookie })).data.readOnly, undefined, 'you are your own admin');
  assert.equal((await call('/api/admin/users', { cookie })).status, 403, 'no user management for one person');

  assert.equal((await call('/api/auth/logout', { method: 'POST', cookie })).status, 200);
  assert.equal((await call('/api/chats', { cookie })).status, 401);
});

test('a forged cookie is rejected', async () => {
  assert.equal((await call('/api/chats', { cookie: 'tinywebui_session=abc.def' })).status, 401);
});

test('five wrong passwords lock the address out', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await login('wrong')).status, 401);
  assert.equal((await login('correct horse')).status, 429);
});

test('refuses to start without a password, with a plaintext one, or in multiuser mode', async () => {
  delete process.env.TINYWEBUI_PASSWORD;
  await assert.rejects(boot({ authMode: 'single', authPassword: '' }), /needs a password/);
  await assert.rejects(boot({ authMode: 'single', authPassword: 'plaintext' }), /must be a hash/);
  await assert.rejects(boot({ authMode: 'multiuser' }), /trusted-header/);
});
