// Request hardening: body limits, cross-site refusal, security headers, IDs.
import test from 'node:test';
import assert from 'node:assert/strict';

const { start } = await import('../src/server.js');
const srv = await start({ port: 0, host: '127.0.0.1', configFile: false, mcpServers: {}, dbPath: ':memory:',
  config: { authMode: 'none', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k' } });
test.after(() => srv.shutdown());
const base = `http://127.0.0.1:${srv.address().port}`;

test('every response carries the security headers', async () => {
  for (const path of ['/', '/api/chats']) {
    const res = await fetch(base + path);
    assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
  }
});

test('a cross-site mutation is refused; same-origin and non-browser clients are not', async () => {
  const post = (headers) => fetch(`${base}/api/folders`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{"name":"f"}' });
  assert.equal((await post({ origin: 'https://evil.example' })).status, 403);
  assert.equal((await post({ origin: 'null' })).status, 403);
  assert.equal((await post({ 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await post({ origin: base })).status, 200);
  assert.equal((await post({})).status, 200, 'scripts and curl send no Origin');
  // Reads are never blocked: a GET cannot change anything.
  assert.equal((await fetch(`${base}/api/folders`, { headers: { origin: 'https://evil.example' } })).status, 200);
});

test('oversized and malformed bodies are refused', async () => {
  const big = JSON.stringify({ name: 'x'.repeat(2 * 1024 * 1024) });
  const r = await fetch(`${base}/api/folders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: big });
  assert.equal(r.status, 413);
  const bad = await fetch(`${base}/api/folders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
  assert.equal(bad.status, 400);
});

test('server-made ids are long random values', async () => {
  const { Store, ALL_USERS } = await import('../src/store/index.js');
  const store = new Store(':memory:');
  const chat = store.chats.create({}, ALL_USERS);
  assert.match(chat.id, /^[0-9a-f-]{36}$/);
  const doc = store.documents.add(chat.id, { filename: 'a', content: 'b' });
  assert.match(doc.id, /^[0-9a-f]{24}$/);
  assert.match(store.messages.addArtifact(chat.id, { toolName: 't', content: 'c' }), /^[0-9a-f]{24}$/);
  store.close();
});
