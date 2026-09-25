// Per-role features: a chat-only user gets a chat app, and the server
// refuses everything else no matter what the browser sends.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { trustedServer } from './trusted-helpers.js';
import { API_ROUTES } from '../src/server.js';

const { srv, as } = await trustedServer({
  access: { roles: { user: { features: ['chat'] } }, bootstrapAdmins: [] }
});
test.after(() => srv.shutdown());
const user = as({ id: 'sub-chatonly' });
const admin = as({ id: 'sub-boss', role: 'admin' });

test('/api/auth/me lists exactly the role\'s features', async () => {
  assert.deepEqual((await user('/api/auth/me')).data.features, ['chat']);
  assert.ok((await admin('/api/auth/me')).data.features.includes('oversight'));
});

test('a chat-only user is refused every other feature', async () => {
  const b64 = Buffer.from('x').toString('base64');
  const refused = [
    ['POST', '/api/config', { systemPrompt: 'x' }, 'settings'],
    ['GET', '/api/models', undefined, 'model-picker'],
    ['GET', '/api/tools', undefined, 'tools'],
    ['POST', '/api/tools/toggle', { name: 'x', disabled: true }, 'tools'],
    ['GET', '/api/mcp', undefined, 'mcp'],
    ['GET', '/api/search?q=x', undefined, 'search'],
    ['GET', '/api/usage', undefined, 'statistics'],
    ['GET', '/api/folders', undefined, 'folders'],
    ['GET', '/api/automations', undefined, 'automations'],
    ['POST', '/api/chats/c1/documents', { filename: 'a.txt', mime: 'text/plain', dataBase64: b64 }, 'attachments'],
    ['POST', '/api/images/normalize', {}, 'images'],
    ['POST', '/api/chat', { message: 'hi', images: [{ mime: 'image/png', data: b64 }] }, 'images'],
    ['GET', '/api/admin/users', undefined, 'admin'],
    ['GET', '/api/admin/chats/x', undefined, 'oversight'],
  ];
  for (const [method, path, body, feature] of refused) {
    const r = await user(path, { method, body });
    assert.equal(r.status, 403, `${method} ${path}`);
    assert.equal(r.data.feature, feature, `${method} ${path}`);
  }
  // What they do have still works.
  assert.equal((await user('/api/chats')).status, 200);
  assert.equal((await user('/api/config')).data.readOnly, true);
});

test('an unknown API route is a 404, not an open door', async () => {
  assert.equal((await admin('/api/secret-new-thing')).status, 404);
});

test('every route the server handles is in the feature table', () => {
  // Each `req.url === '/api/...'` literal and each route regex in server.js
  // must be matched by some table entry.
  const src = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const literals = [...src.matchAll(/req\.url === '(\/api\/[^']+)'/g)].map((m) => m[1]);
  assert.ok(literals.length > 10);
  for (const path of literals) {
    assert.ok(API_ROUTES.some(([, re]) => re.test(path)), `${path} is not in ROUTES`);
  }
  const samples = ['/api/chats/abc', '/api/chats/abc/stream', '/api/chats/abc/stop', '/api/chats/abc/approve',
    '/api/chats/abc/edit', '/api/chats/abc/organize', '/api/chats/abc/documents', '/api/documents/abc',
    '/api/automations/abc', '/api/automations/abc/runs', '/api/automations/abc/trigger', '/api/mcp/servers/x/toggle',
    '/api/admin/users/abc', '/api/admin/users/abc/chats', '/api/admin/chats/abc', '/api/admin/documents/abc'];
  for (const path of samples) assert.ok(API_ROUTES.some(([, re]) => re.test(path)), path);
});
