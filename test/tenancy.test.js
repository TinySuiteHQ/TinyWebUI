// Tenant isolation, as a matrix: Alice aims every user-scoped route at Bob's
// ids and must get "no such thing" -- never Bob's data, never a change to it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { trustedServer } from './trusted-helpers.js';

const { srv, as } = await trustedServer();
test.after(() => srv.shutdown());

const alice = as({ id: 'sub-alice', email: 'alice@example.com', role: 'admin' });
const bob = as({ id: 'sub-bob', email: 'bob@example.com' });

// Bob's world: a chat with a searchable message, a document, a folder, an automation.
await bob('/api/chats/import', { method: 'POST', body: { chats: [{ id: 'bob-chat', title: 'Bob private', messages: [{ role: 'user', content: 'zanzibarsecret plans' }] }] } });
const bobDoc = (await bob('/api/chats/bob-chat/documents', { method: 'POST', body: {
  filename: 'bob.txt', mime: 'text/plain', dataBase64: Buffer.from('bob document body').toString('base64')
} })).data.document;
await bob('/api/folders', { method: 'POST', body: { name: 'bob-folder' } });
const bobAuto = (await bob('/api/automations', { method: 'POST', body: {
  chatId: 'bob-chat', name: 'bob job', prompt: 'p', cron: '0 9 * * *', timezone: 'UTC'
} })).data.automation;

test('setup: Bob owns what he made', async () => {
  assert.ok(bobDoc?.id);
  assert.ok(bobAuto?.id);
  assert.equal((await bob('/api/chats/bob-chat')).status, 200);
});

test('Alice cannot read, change or delete anything of Bob\'s by id', async () => {
  const denied = [
    ['GET', '/api/chats/bob-chat'],
    ['POST', '/api/chats/bob-chat/organize', { folder: 'x', tags: ['t'] }],
    ['DELETE', '/api/chats/bob-chat'],
    ['GET', '/api/chats/bob-chat/stream'],
    ['POST', '/api/chats/bob-chat/stop', {}],
    ['POST', '/api/chats/bob-chat/approve', { id: 'x', decision: 'allow' }],
    ['POST', '/api/chats/bob-chat/edit', { seq: 0, message: 'hijack' }],
    ['POST', '/api/chats/bob-chat/documents', { filename: 'a.txt', mime: 'text/plain', dataBase64: Buffer.from('x').toString('base64') }],
    ['POST', '/api/chat', { chatId: 'bob-chat', message: 'hijack' }],
    ['GET', `/api/documents/${bobDoc.id}`],
    ['GET', `/api/automations/${bobAuto.id}/runs`],
    ['PATCH', `/api/automations/${bobAuto.id}`, { enabled: false }],
    ['POST', `/api/automations/${bobAuto.id}/trigger`, {}],
    ['DELETE', `/api/automations/${bobAuto.id}`],
  ];
  for (const [method, path, body] of denied) {
    const { status } = await alice(path, { method, body });
    assert.ok(status === 404 || status === 403 || status === 400, `${method} ${path} -> ${status}`);
  }
  // And nothing of Bob's moved.
  const still = await bob('/api/chats/bob-chat');
  assert.equal(still.status, 200);
  assert.equal(still.data.messages.length, 1);
  assert.equal((await bob(`/api/documents/${bobDoc.id}`)).status, 200);
  const autos = (await bob('/api/automations')).data.automations;
  assert.equal(autos.find((a) => a.id === bobAuto.id)?.enabled, true);
});

test('Alice\'s lists, search, folders and usage show none of Bob\'s rows', async () => {
  assert.deepEqual((await alice('/api/chats')).data.chats ?? (await alice('/api/chats')).data, []);
  assert.deepEqual((await alice('/api/search?q=zanzibarsecret')).data.results, []);
  assert.equal((await bob('/api/search?q=zanzibarsecret')).data.results.length, 1);
  assert.ok(!(await alice('/api/folders')).data.folders.includes('bob-folder'));
  assert.deepEqual((await alice('/api/automations')).data.automations, []);
  const usage = (await alice('/api/usage')).data;
  assert.deepEqual(usage.days, []);
});

test('import cannot claim an id someone else already holds', async () => {
  const out = await alice('/api/chats/import', { method: 'POST', body: { chats: [{ id: 'bob-chat', messages: [{ role: 'user', content: 'x' }] }] } });
  assert.equal(out.data.imported, 0);
  assert.equal((await bob('/api/chats/bob-chat')).data.messages.length, 1);
});
