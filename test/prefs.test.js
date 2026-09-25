// Tier 3's model pill: each person picks among their role's models, and
// their turns actually use that model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { trustedServer } from './trusted-helpers.js';

const seen = [];
const fake = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    if (req.url.endsWith('/models')) { res.writeHead(404); return res.end(); }
    seen.push(JSON.parse(body).model);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
});
const port = await new Promise((r) => fake.listen(0, '127.0.0.1', () => r(fake.address().port)));

const { srv, as } = await trustedServer({
  baseUrl: `http://127.0.0.1:${port}/v1`, model: 'house-default',
  access: { roles: { user: { features: ['chat', 'model-picker'], models: ['fast', 'smart'] } } }
});
test.after(async () => { await srv.shutdown(); fake.close(); });
const alice = as({ id: 'sub-alice' });
const bob = as({ id: 'sub-bob' });

const chat = async (who, message) => {
  const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-tinysuite-user-id': who }, body: JSON.stringify({ message })
  });
  await res.text(); // drain the stream: the turn is over
};

test('the default is the first allowed model when the house default is not allowed', async () => {
  assert.equal((await alice('/api/auth/me')).data.model, 'fast');
  assert.deepEqual((await alice('/api/models')).data.models.map((m) => m.id), ['fast', 'smart']);
});

test('a pick is personal, limited to the role, and used by turns', async () => {
  assert.equal((await alice('/api/me/prefs', { method: 'POST', body: { model: 'smart' } })).data.model, 'smart');
  assert.equal((await alice('/api/me/prefs', { method: 'POST', body: { model: 'gpt-free-for-all' } })).status, 403);
  assert.equal((await bob('/api/auth/me')).data.model, 'fast', 'Bob is unaffected');

  await chat('sub-alice', 'hi');
  await chat('sub-bob', 'hi');
  assert.deepEqual(seen.slice(-2), ['smart', 'fast']);
  assert.equal((await alice('/api/config')).data.model, 'house-default', 'the configured model did not move');
});
