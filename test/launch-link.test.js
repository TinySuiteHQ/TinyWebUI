// Tier 2 without a password: a loopback install signs in with the link it prints.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashPassword } from '../src/access/auth.js';

const dir = mkdtempSync(join(tmpdir(), 'tinywebui-link-'));
const { start } = await import('../src/server.js');
const boot = (name, config = {}) => start({
  port: 0, host: '127.0.0.1', configFile: false, mcpServers: {}, dbPath: join(dir, `${name}.db`),
  config: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'm', sessionSecret: 's'.repeat(64), authMode: 'single', ...config }
});
const srv = await boot('link');
test.after(() => srv.shutdown());
const base = `http://127.0.0.1:${srv.address().port}`;
const token = new URL(srv.launchUrl).hash.slice('#token='.length);

const call = async (path, { method = 'GET', body, cookie } = {}) => {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, data: await res.json().catch(() => null), cookie: res.headers.get('set-cookie')?.split(';')[0] };
};

test('the printed link carries a long random token in the fragment', () => {
  assert.match(srv.launchUrl, new RegExp(`^${base}/#token=[0-9a-f]{64}$`));
});

test('locked until the token is traded for a session', async () => {
  assert.equal((await call('/api/chats')).status, 401);
  const me = await call('/api/auth/me');
  assert.equal(me.data.login, 'link');
  const bad = await call('/api/auth/login', { method: 'POST', body: { token: 'f'.repeat(64) } });
  assert.equal(bad.status, 401);
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { password: 'anything at all here' } })).status, 401);
  const ok = await call('/api/auth/login', { method: 'POST', body: { token } });
  assert.equal(ok.status, 200);
  assert.equal((await call('/api/chats', { cookie: ok.cookie })).status, 200);
});

test('with a password set, the token is not a way in', async () => {
  const pw = await boot('pw', { authPassword: hashPassword('correct horse battery') });
  try {
    const at = `http://127.0.0.1:${pw.address().port}`;
    const res = await fetch(`${at}/api/auth/me`);
    assert.equal((await res.json()).login, 'password');
    const own = new URL(pw.launchUrl).hash.slice('#token='.length);
    const login = await fetch(`${at}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: own })
    });
    assert.equal(login.status, 401);
  } finally { await pw.shutdown(); }
});
