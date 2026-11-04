// Asking for an account from the sign-in page: a pending local user that an
// admin approves into a role. Off until an admin switches it on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../src/server.ts';
import { Store } from '../src/store/index.ts';

const dir = mkdtempSync(join(tmpdir(), 'tinywebui-requests-'));
const configFile = join(dir, 'tinywebui.config.json');
writeFileSync(configFile, JSON.stringify({ baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'm' }));
writeFileSync(join(dir, 'mcp.json'), '{ "mcpServers": {} }\n');
const srv = await start({
  port: 0, host: '127.0.0.1', configFile, dbPath: join(dir, 'r.db'),
  config: { authMode: 'multiuser', sessionSecret: 's'.repeat(64), retrieval: { mode: 'lexical' } }
});
test.after(() => srv.shutdown());
const base = `http://127.0.0.1:${srv.address().port}`;

async function call(path, { method = 'GET', body, cookie } = {}) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, data: await res.json().catch(() => null), cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
const ask = (body) => call('/api/auth/request-access', { method: 'POST', body });

let admin;

test('nothing to ask before there is an administrator', async () => {
  assert.equal((await call('/api/auth/me')).data.canRequest, false);
  assert.equal((await ask({ email: 'early@example.com', password: 'early password' })).status, 403);
  admin = (await call('/api/auth/setup', { method: 'POST', body: { email: 'owner@example.com', password: 'owner password' } })).cookie;
  assert.equal((await call('/api/auth/me')).data.canRequest, false, 'off by default, even with an admin');
  assert.equal((await ask({ email: 'early@example.com', password: 'early password' })).status, 403);
  assert.equal((await call('/api/admin/policy', { cookie: admin })).data.allowRequests, false);
});

test('an admin can switch requests on, and the choice is written to the file', async () => {
  const on = await call('/api/admin/policy', { method: 'PATCH', cookie: admin, body: { allowRequests: true } });
  assert.deepEqual([on.status, on.data.allowRequests], [200, true]);
  assert.equal(JSON.parse(readFileSync(configFile, 'utf8')).access.allowRequests, true);
  assert.equal((await call('/api/auth/me')).data.canRequest, true);
});

test('a request waits for approval, and its sign-in reaches only the waiting room', async () => {
  assert.equal((await ask({ email: 'bad', password: 'long enough pw' })).status, 400);
  assert.equal((await ask({ email: 'ann@example.com', password: 'short' })).status, 400);
  assert.equal((await ask({ email: 'ann@example.com', password: 'ann password', note: 42 })).status, 400);
  assert.equal((await ask({ email: 'ann@example.com', password: 'ann password', note: 'x'.repeat(501) })).status, 400);
  const sent = await ask({ email: 'Ann@Example.com', password: 'ann password', note: '  From the data team.  ' });
  assert.deepEqual([sent.status, sent.data], [202, { ok: true }]);

  const waiting = (await call('/api/admin/users', { cookie: admin })).data.users.find((u) => u.email === 'ann@example.com');
  assert.deepEqual([waiting.status, waiting.role, waiting.hasPassword, waiting.note], ['pending', 'user', true, 'From the data team.']);

  const login = await call('/api/auth/login', { method: 'POST', body: { email: 'ann@example.com', password: 'ann password' } });
  assert.equal(login.status, 200, 'a pending account signs in to the waiting room');
  const me = (await call('/api/auth/me', { cookie: login.cookie })).data;
  assert.deepEqual([me.user.status, me.features, me.canRequest], ['pending', [], false]);
  assert.equal((await call('/api/chats', { cookie: login.cookie })).data.error, 'pending_approval');

  assert.equal((await call(`/api/admin/users/${waiting.id}`, { method: 'PATCH', cookie: admin, body: { status: 'approved', role: 'user' } })).status, 200);
  const in_ = await call('/api/auth/login', { method: 'POST', body: { email: 'ann@example.com', password: 'ann password' } });
  assert.equal((await call('/api/chats', { cookie: in_.cookie })).status, 200);
  const ann = (await call('/api/admin/users', { cookie: admin })).data.users.find((u) => u.email === 'ann@example.com');
  assert.equal(ann.note, null, 'the note is shown only while the request waits');
});

test('asking with an address that has an account looks the same and changes nothing', async () => {
  const again = await ask({ email: 'owner@example.com', password: 'attacker password' });
  assert.deepEqual([again.status, again.data], [202, { ok: true }]);
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { email: 'owner@example.com', password: 'attacker password' } })).status, 401);
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { email: 'owner@example.com', password: 'owner password' } })).status, 200);
});

test('a turned-away request cannot sign in', async () => {
  assert.equal((await ask({ email: 'bob@example.com', password: 'bob password' })).status, 202);
  const bob = (await call('/api/admin/users', { cookie: admin })).data.users.find((u) => u.email === 'bob@example.com');
  await call(`/api/admin/users/${bob.id}`, { method: 'PATCH', cookie: admin, body: { status: 'disabled' } });
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { email: 'bob@example.com', password: 'bob password' } })).status, 403);
});

test('requests from one address are limited', async () => {
  // Three so far from this address in the tests above that got past validation (the 403s while off don't count).
  const statuses = [];
  for (let i = 0; i < 3; i++) statuses.push((await ask({ email: `spam${i}@example.com`, password: 'spam password' })).status);
  assert.deepEqual(statuses, [202, 202, 429]);
});

test('an admin can switch requests off again', async () => {
  assert.equal((await call('/api/admin/policy', { method: 'PATCH', cookie: admin, body: { allowRequests: 'no' } })).status, 400);
  const off = await call('/api/admin/policy', { method: 'PATCH', cookie: admin, body: { allowRequests: false } });
  assert.deepEqual([off.status, off.data.allowRequests], [200, false]);
  assert.equal(JSON.parse(readFileSync(configFile, 'utf8')).access.allowRequests, false);
  assert.equal((await call('/api/auth/me')).data.canRequest, false);
  assert.equal((await ask({ email: 'late@example.com', password: 'late password' })).status, 403);
});

test('the store never overwrites an account, and caps how many may wait', () => {
  const store = new Store(':memory:');
  const req = (email, maxWaiting = 2) => store.users.requestAccess({ email, passwordHash: 'h', note: null, maxWaiting });
  assert.equal(req('a@x.test'), 'created');
  assert.equal(req('a@x.test'), 'exists');
  assert.equal(req('b@x.test'), 'created');
  assert.equal(req('c@x.test'), 'full');
  store.close();
});
