// Personal instructions: off until an admin lists them in access.customize,
// then per user, appended after the system prompt on that user's turns only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { trustedServer } from './trusted-helpers.js';

const prompts = [];
const fake = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    if (req.url.endsWith('/models')) { res.writeHead(404); return res.end(); }
    prompts.push(JSON.parse(body).messages.find((m) => m.role === 'system')?.content || '');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
});
const port = await new Promise((r) => fake.listen(0, '127.0.0.1', () => r(fake.address().port)));

const mk = (customize) => trustedServer({
  baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm', systemPrompt: 'BASE',
  access: { customize, roles: { user: { features: ['chat'], models: '*' } } }
});
const on = await mk(['theme', 'instructions']);
const off = await mk(['theme']);
test.after(async () => { await on.srv.shutdown(); await off.srv.shutdown(); fake.close(); });

const chat = async (s, who, message) => {
  const res = await fetch(`http://127.0.0.1:${s.srv.address().port}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-tinysuite-user-id': who }, body: JSON.stringify({ message })
  });
  await res.text();
};

test('refused until an admin allows it, even for a role without the model picker', async () => {
  const r = await off.as({ id: 'sub-a' })('/api/me/prefs', { method: 'POST', body: { instructions: 'Be terse.' } });
  assert.equal(r.status, 403);
  assert.deepEqual((await off.as({ id: 'sub-a' })('/api/auth/me')).data.customize, ['theme']);
});

test('saved per user and used only on that user\'s turns', async () => {
  const alice = on.as({ id: 'sub-alice' });
  const r = await alice('/api/me/prefs', { method: 'POST', body: { instructions: ' Be terse. ' } });
  assert.equal(r.data.instructions, 'Be terse.');
  assert.equal((await alice('/api/auth/me')).data.instructions, 'Be terse.');
  await chat(on, 'sub-alice', 'hi');
  await chat(on, 'sub-bob', 'hi');
  assert.match(prompts.at(-2), /BASE[\s\S]*Be terse\./);
  assert.ok(!prompts.at(-1).includes('Be terse.'));
  await alice('/api/me/prefs', { method: 'POST', body: { instructions: null } });
  assert.equal((await alice('/api/auth/me')).data.instructions, '');
});

test('/api/auth/me reports the current model\'s capability tags', async () => {
  const t = await trustedServer({
    baseUrl: `http://127.0.0.1:${port}/v1`, model: 'eyes',
    models: [{ id: 'eyes', tags: ['vision'] }, { id: 'plain' }]
  });
  try {
    assert.deepEqual((await t.as({ id: 'sub-x' })('/api/auth/me')).data.modelTags, ['vision']);
  } finally { await t.srv.shutdown(); }
});
