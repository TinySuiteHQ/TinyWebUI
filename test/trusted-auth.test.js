// Trusted-header identity: who the gateway says you are, provisioned on first
// sight, and nothing a browser can forge or escalate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { trustedServer } from './trusted-helpers.js';
import { Store, ALL_USERS } from '../src/store/index.js';
import { ipInCidrs } from '../src/access/auth.js';

const { srv, as, seedChat } = await trustedServer({ logoutUrl: 'https://team.example/cdn-cgi/access/logout' });
test.after(() => srv.shutdown());

const admin = as({ id: 'sub-admin', email: 'admin@example.com', role: 'admin' });
await admin('/api/auth/me');

test('no identity header is 401; login routes do not exist', async () => {
  assert.equal((await as(null)('/api/chats')).status, 401);
  assert.equal((await as(null)('/api/auth/login', { method: 'POST', body: {} })).status, 404);
  assert.equal((await admin('/api/auth/google')).status, 404);
});

test('first request provisions; concurrent first requests make exactly one user', async () => {
  const carol = as({ id: 'sub-carol', email: 'carol@example.com', name: 'Carol' });
  const results = await Promise.all(Array.from({ length: 10 }, () => carol('/api/auth/me')));
  const ids = new Set(results.map((r) => r.data.user.id));
  assert.equal(ids.size, 1);
  const users = (await admin('/api/admin/users')).data.users.filter((u) => u.email === 'carol@example.com');
  assert.equal(users.length, 1);
  assert.equal(users[0].role, 'user');
  assert.equal(users[0].status, 'approved');
});

test('a changed email with the same subject is the same account', async () => {
  const before = as({ id: 'sub-dave', email: 'dave@old.example' });
  await seedChat({ id: 'sub-dave', email: 'dave@old.example' }, { id: 'dave-chat', content: 'hi' });
  const after = as({ id: 'sub-dave', email: 'dave@new.example' });
  const me = (await after('/api/auth/me')).data.user;
  assert.equal(me.email, 'dave@new.example');
  assert.equal((await after('/api/chats/dave-chat')).status, 200);
  // Someone else claiming Dave's email gets no email, not Dave's account.
  const imposter = as({ id: 'sub-imposter', email: 'dave@new.example' });
  const other = (await imposter('/api/auth/me')).data.user;
  assert.notEqual(other.id, me.id);
  assert.equal(other.email, null);
  assert.equal((await imposter('/api/chats/dave-chat')).status, 404);
});

test('role follows the gateway; nothing else can set it', async () => {
  const erin = as({ id: 'sub-erin', role: 'admin' });
  assert.equal((await erin('/api/auth/me')).data.isAdmin, true);
  const demoted = as({ id: 'sub-erin', role: 'user' });
  assert.equal((await demoted('/api/auth/me')).data.isAdmin, false);
  // A made-up role header is ignored rather than trusted.
  const weird = as({ id: 'sub-erin', role: 'superuser' });
  assert.equal((await weird('/api/auth/me')).data.user.role, 'user');
  assert.equal((await demoted('/api/admin/users')).status, 403);
});

test('non-admins cannot change deployment config and do not see its secrets', async () => {
  const user = as({ id: 'sub-frank' });
  assert.equal((await user('/api/config', { method: 'POST', body: { systemPrompt: 'pwned' } })).status, 403);
  assert.equal((await user('/api/tools/toggle', { method: 'POST', body: { name: 'x', disabled: true } })).status, 403);
  assert.equal((await user('/api/tools/approval', { method: 'POST', body: { name: 'x', policy: 'auto' } })).status, 403);
  assert.equal((await user('/api/mcp', { method: 'POST', body: { text: '{}' } })).status, 403);
  assert.equal((await user('/api/mcp/servers/x/toggle', { method: 'POST', body: { disabled: true } })).status, 403);
  const cfg = (await user('/api/config')).data;
  assert.equal(cfg.readOnly, true);
  for (const k of ['baseUrl', 'trustedProxyCidrs', 'apiKey', 'sessionSecret']) assert.equal(k in cfg, false, k);
  assert.equal((await user('/api/mcp')).status, 403);
  assert.ok('baseUrl' in (await admin('/api/config')).data);
});

test('admin approves, disables and re-enables; disabled is a hard 403', async () => {
  const gina = as({ id: 'sub-gina' });
  const id = (await gina('/api/auth/me')).data.user.id;
  const set = (body) => admin(`/api/admin/users/${id}`, { method: 'PATCH', body });

  assert.equal((await set({ status: 'disabled' })).status, 200);
  assert.equal((await gina('/api/chats')).status, 403);
  assert.equal((await gina('/api/chats')).data.error, 'disabled');

  assert.equal((await set({ status: 'pending' })).status, 200);
  assert.equal((await gina('/api/chats')).data.error, 'pending_approval');
  assert.equal((await gina('/api/auth/me')).status, 200, 'pending can still ask who it is');

  assert.equal((await set({ status: 'approved', role: 'admin' })).status, 200);
  assert.equal((await gina('/api/chats')).status, 200);
  assert.equal((await gina('/api/auth/me')).data.isAdmin, true);

  assert.equal((await set({ status: 'banana' })).status, 400);
  assert.equal((await admin('/api/admin/users/nope', { method: 'PATCH', body: { status: 'approved' } })).status, 404);
});

test('an admin cannot demote or disable themselves', async () => {
  const me = (await admin('/api/auth/me')).data.user;
  assert.equal((await admin(`/api/admin/users/${me.id}`, { method: 'PATCH', body: { status: 'disabled' } })).status, 400);
  assert.equal((await admin(`/api/admin/users/${me.id}`, { method: 'PATCH', body: { role: 'user' } })).status, 400);
});

test('logout hands the browser to the gateway', async () => {
  assert.equal((await admin('/api/auth/me')).data.logoutUrl, 'https://team.example/cdn-cgi/access/logout');
  assert.equal((await admin('/api/auth/logout', { method: 'POST' })).data.redirect, 'https://team.example/cdn-cgi/access/logout');
});

test('headers from an untrusted peer are ignored', async () => {
  const other = await trustedServer({ trustedProxyCidrs: ['10.0.0.0/8'] });
  try {
    const r = await other.as({ id: 'sub-admin', role: 'admin' })('/api/auth/me');
    assert.equal(r.status, 401);
  } finally { await other.srv.shutdown(); }
});

test('trusted-header mode refuses to start without trusted proxies', async () => {
  await assert.rejects(trustedServer({ trustedProxyCidrs: [] }), /trustedProxyCidrs/);
});

test('cidr matching handles v4, v6 and v4-mapped peers', () => {
  const cidrs = ['172.20.0.0/16', '::1/128'];
  assert.equal(ipInCidrs('172.20.4.5', cidrs), true);
  assert.equal(ipInCidrs('::ffff:172.20.4.5', cidrs), true);
  assert.equal(ipInCidrs('172.21.0.1', cidrs), false);
  assert.equal(ipInCidrs('::1', cidrs), true);
  assert.equal(ipInCidrs(undefined, cidrs), false);
});

test('scoped store reads refuse a missing scope', () => {
  const store = new Store(':memory:');
  const chat = store.chats.create({ title: 't' }, 'u1');
  assert.throws(() => store.chats.get(chat.id), /user scope is required/);
  assert.throws(() => store.chats.list(10), /user scope is required/);
  assert.throws(() => store.search.chats('t', 10), /user scope is required/);
  assert.equal(store.chats.get(chat.id, 'u2'), null);
  assert.equal(store.chats.get(chat.id, null), null);
  assert.ok(store.chats.get(chat.id, 'u1'));
  assert.ok(store.chats.get(chat.id, ALL_USERS));
  store.close();
});

test('admins can read any user\'s chats and documents; users cannot', async () => {
  const hank = as({ id: 'sub-hank', email: 'hank@example.com' });
  const hankId = (await hank('/api/auth/me')).data.user.id;
  await seedChat({ id: 'sub-hank', email: 'hank@example.com' }, { id: 'hank-chat', title: 'Hank', content: 'hank says hi' });
  const doc = (await hank('/api/chats/hank-chat/documents', { method: 'POST', body: {
    filename: 'h.txt', mime: 'text/plain', dataBase64: Buffer.from('hank doc').toString('base64')
  } })).data.document;

  const list = await admin(`/api/admin/users/${hankId}/chats`);
  assert.equal(list.status, 200);
  assert.deepEqual(list.data.chats.map((c) => c.id), ['hank-chat']);
  const chat = await admin('/api/admin/chats/hank-chat');
  assert.equal(chat.data.messages[0].content, 'hank says hi');
  assert.equal(chat.data.owner.email, 'hank@example.com');
  assert.equal((await admin(`/api/admin/documents/${doc.id}`)).data.content, 'hank doc');

  const other = as({ id: 'sub-ivy' });
  assert.equal((await other(`/api/admin/users/${hankId}/chats`)).status, 403);
  assert.equal((await other('/api/admin/chats/hank-chat')).status, 403);
  assert.equal((await other(`/api/admin/documents/${doc.id}`)).status, 403);
  assert.equal((await admin('/api/admin/chats/nope')).status, 404);
});
