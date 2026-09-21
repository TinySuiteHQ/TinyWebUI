// Rewriting a question drops the answers that followed it and runs again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/store.js';

let reply = 'first answer';
const fake = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 2 } })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

const port = await new Promise((r) => fake.listen(0, '127.0.0.1', () => r(fake.address().port)));

const dir = mkdtempSync(join(tmpdir(), 'tinywebui-edit-'));
process.env.TINYWEBUI_CONFIG = join(dir, 'config.json');
process.env.TINYWEBUI_MCP = join(dir, 'mcp.json');
process.env.TINYWEBUI_API_KEY = 'test-key';
process.env.TINYWEBUI_BASE_URL = `http://127.0.0.1:${port}/v1`;
process.env.TINYWEBUI_MODEL = 'fake-model';
process.env.TINYWEBUI_DB = join(dir, 'chats.db');

const { start } = await import('../src/server.js');
const srv = await start({ port: 0, host: '127.0.0.1' });
const base = `http://127.0.0.1:${srv.address().port}`;

const send = async (chatId, message) => {
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chatId, message })
  });
  const text = await res.text();
  return JSON.parse(text.split('data:')[1].split('\n')[0]).id;
};
const load = async (id) => (await fetch(`${base}/api/chats/${id}`)).json();

/** An edit starts a run and returns straight away, so settle before reading. */
async function settled(id) {
  for (let i = 0; i < 100; i++) {
    const chat = await load(id);
    if (!chat.running) return chat;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('the turn never finished');
}

async function edit(id, seq, message) {
  const res = await fetch(`${base}/api/chats/${id}/edit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ seq, message })
  });
  await res.json().catch(() => null);
  return res;
}

test('editing a question drops what came after it and answers again', async () => {
  const id = await send(null, 'first question');
  await send(id, 'second question');

  let chat = await load(id);
  assert.deepEqual(
    chat.messages.map((m) => m.role),
    ['user', 'assistant', 'user', 'assistant'],
    'two rounds to start with'
  );
  const firstSeq = chat.messages[0].seq;

  reply = 'answer after the edit';
  const res = await edit(id, firstSeq, 'first question, rewritten');
  assert.equal(res.status, 200);

  chat = await settled(id);
  assert.deepEqual(chat.messages.map((m) => m.role), ['user', 'assistant']);
  assert.equal(chat.messages[0].content, 'first question, rewritten');
  assert.equal(chat.messages[1].content, 'answer after the edit');
  assert.ok(
    !chat.messages.some((m) => m.content === 'second question'),
    'the follow-up asked of the old question is gone with it'
  );
});

test('a question can be resubmitted unchanged, which is what retry is', async () => {
  reply = 'take one';
  const id = await send(null, 'same question');
  let chat = await load(id);
  assert.equal(chat.messages[1].content, 'take one');

  reply = 'take two';
  await edit(id, chat.messages[0].seq, 'same question');

  chat = await settled(id);
  assert.deepEqual(chat.messages.map((m) => m.role), ['user', 'assistant']);
  assert.equal(chat.messages[0].content, 'same question');
  assert.equal(chat.messages[1].content, 'take two', 'answered fresh, not replayed');
});

test('an edit is refused when it does not name a question of your own', async () => {
  reply = 'hello';
  const id = await send(null, 'a question');
  const chat = await load(id);
  const answerSeq = chat.messages[1].seq;

  const bad = await edit(id, answerSeq, 'putting words in its mouth');
  assert.equal(bad.status, 400);

  const empty = await edit(id, chat.messages[0].seq, '   ');
  assert.equal(empty.status, 400);

  const after = await load(id);
  assert.deepEqual(after.messages.map((m) => m.role), ['user', 'assistant'], 'nothing was rewound');
});

test('truncating below a compaction boundary clears it', () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'trunc-')), 't.db'));
  const chat = store.createChat({ title: 't' });
  for (let i = 0; i < 4; i++) store.addMessage(chat.id, { role: 'user', content: `m${i}` });
  store.touchChat(chat.id, { boundary_seq: 3 });

  store.truncateFrom(chat.id, 2);
  assert.equal(store.messages(chat.id).length, 2);
  assert.equal(store.getChat(chat.id).boundary_seq, -1, 'a frozen prefix inside the cut is no longer frozen');
  store.close();
});

test.after(() => { srv.close(); fake.close(); });
