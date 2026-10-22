// Native local accounts: first user owns the instance; everyone else needs an invite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { start } from '../src/server.js';
import { Store, ALL_USERS } from '../src/store/index.ts';

const dir = mkdtempSync(join(tmpdir(), 'tinywebui-multiuser-'));
const dbPath = join(dir, 'chats.db');
const legacy = new Store(dbPath);
legacy.users.ensureOwner('owner');
legacy.chats.create({ id: 'legacy-chat', title: 'Before accounts' }, ALL_USERS);
legacy.close();
const srv = await start({
  port: 0, host: '127.0.0.1', configFile: false, mcpServers: {}, dbPath,
  config: {
    authMode: 'multiuser', sessionSecret: 's'.repeat(64), retrieval: { mode: 'lexical' },
    baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'm'
  }
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

let adminCookie;
let invite;

test('the first local account is the approved admin', async () => {
  for (const email of ['not-an-email', 'a..b@example.com', 'user@-example.com', 'user@example']) {
    const response = await call('/api/auth/setup', { method: 'POST', body: { email, password: 'valid password' } });
    assert.equal(response.status, 400, email);
    assert.match(response.data.error, /valid email/);
  }
  assert.equal((await call('/api/auth/setup', { method: 'POST', body: {
    email: 'owner@example.com', password: 'short'
  } })).status, 400);

  const setup = await call('/api/auth/setup', { method: 'POST', body: {
    email: 'OWNER@example.com', password: 'owner password'
  } });
  assert.equal(setup.status, 201);
  adminCookie = setup.cookie;

  const me = (await call('/api/auth/me', { cookie: adminCookie })).data;
  assert.equal(me.needsSetup, false);
  assert.deepEqual([me.user.email, me.user.role, me.user.status], ['owner@example.com', 'admin', 'approved']);
  assert.equal(me.user.name, null);
  assert.ok(me.features.includes('admin'));
  assert.deepEqual((await call('/api/chats', { cookie: adminCookie })).data.chats.map((c) => c.id), ['legacy-chat']);
  assert.equal((await call('/api/auth/setup', { method: 'POST', body: {
    email: 'second@example.com', password: 'second password'
  } })).status, 409);

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const stored = db.prepare('SELECT password_hash FROM users WHERE email = ?').get('owner@example.com').password_hash;
  assert.equal(db.prepare('SELECT 1 FROM users WHERE id = ?').get('owner'), undefined);
  db.close();
  assert.match(stored, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  assert.ok(!stored.includes('owner password'));
});

test('an admin creates a hashed, expiring invitation', async () => {
  const made = await call('/api/admin/invites', { method: 'POST', cookie: adminCookie, body: { email: 'friend@example.com' } });
  assert.equal(made.status, 201);
  assert.match(made.data.token, /^[0-9a-f]{64}$/);
  assert.equal(made.data.invite.email, 'friend@example.com');
  invite = made.data;

  assert.equal((await call('/api/admin/invites', { method: 'POST', cookie: adminCookie,
    body: { email: 'bad..mail@example.com' } })).status, 400);

  const listed = await call('/api/admin/invites', { cookie: adminCookie });
  assert.deepEqual(listed.data.invites.map((i) => i.id), [invite.invite.id]);

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const stored = db.prepare('SELECT token_hash FROM invitations WHERE id = ?').get(invite.invite.id).token_hash;
  db.close();
  assert.notEqual(stored, invite.token);
});

test('the invitation is email-bound, single-use, and creates a regular user', async () => {
  const wrong = await call('/api/auth/accept-invite', { method: 'POST', body: {
    token: invite.token, email: 'other@example.com', password: 'friend password'
  } });
  assert.equal(wrong.status, 400);

  const joined = await call('/api/auth/accept-invite', { method: 'POST', body: {
    token: invite.token, email: 'FRIEND@example.com', password: 'friend password'
  } });
  assert.equal(joined.status, 201);
  const userCookie = joined.cookie;
  const me = (await call('/api/auth/me', { cookie: userCookie })).data;
  assert.deepEqual([me.user.email, me.user.role, me.user.status], ['friend@example.com', 'user', 'approved']);
  assert.equal(me.user.name, null);
  assert.ok(!me.features.includes('admin'));
  assert.equal((await call('/api/admin/users', { cookie: userCookie })).status, 403);
  assert.equal((await call('/api/admin/invites', { method: 'POST', cookie: userCookie, body: {} })).status, 403);

  assert.equal((await call('/api/auth/accept-invite', { method: 'POST', body: {
    token: invite.token, email: 'friend2@example.com', password: 'another password'
  } })).status, 400);
  assert.deepEqual((await call('/api/admin/invites', { cookie: adminCookie })).data.invites, []);
});

test('local users sign in by normalized email and can log out', async () => {
  const login = await call('/api/auth/login', { method: 'POST', body: { email: ' FRIEND@EXAMPLE.COM ', password: 'friend password' } });
  assert.equal(login.status, 200);
  assert.equal((await call('/api/chats', { cookie: login.cookie })).status, 200);
  assert.equal((await call('/api/auth/logout', { method: 'POST', cookie: login.cookie })).status, 200);
  assert.equal((await call('/api/chats', { cookie: login.cookie })).status, 401);
});
