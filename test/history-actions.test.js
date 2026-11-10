// Changing the history from the transcript: deleting a question or an answer
// (with everything after it), editing an answer in place, and forking a chat
// into a new one listed under it, with or without its files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sent = [];
let n = 0;
const fake = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    if (req.url.endsWith('/models')) { res.writeHead(404); return res.end(); }
    sent.push(JSON.parse(body).messages);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `answer ${++n}` } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 2 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
});
const port = await new Promise((r) => fake.listen(0, '127.0.0.1', () => r(fake.address().port)));

const dir = mkdtempSync(join(tmpdir(), 'tinywebui-history-'));
const mcp = join(dir, 'mcp.json');
writeFileSync(mcp, '{ "mcpServers": {} }');
const { start } = await import('../server/server.ts');
const srv = await start({
  port: 0, host: '127.0.0.1', configFile: false, mcpServers: {}, dbPath: join(dir, 'chats.db'),
  config: { authMode: 'local', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', model: 'fake-model', retrieval: { mode: 'lexical' } }
});
test.after(async () => { await srv.shutdown(); fake.close(); });
const base = `http://127.0.0.1:${srv.address().port}`;

const call = async (path, { method = 'GET', body } = {}) => {
  const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => null) };
};
const send = async (chatId, message, extra = {}) => {
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chatId, message, ...extra })
  });
  const text = await res.text();
  return JSON.parse(text.split('data:')[1].split('\n')[0]).id;
};
const load = async (id) => (await call(`/api/chats/${id}`)).data;
/** A chat of three questions and their answers. */
async function threeRounds() {
  const id = await send(null, 'one');
  await send(id, 'two');
  await send(id, 'three');
  const chat = await load(id);
  return { id, q: chat.messages.filter((m) => m.role === 'user').map((m) => m.seq) };
}

test('the question seqs come back on their own, for a view drawn from a live stream', async () => {
  const { id, q } = await threeRounds();
  assert.deepEqual((await call(`/api/chats/${id}/questions`)).data.seqs, q);
  assert.equal((await call('/api/chats/nope/questions')).status, 404);
});

test('deleting a question removes it and everything after it', async () => {
  const { id, q } = await threeRounds();
  assert.equal((await call(`/api/chats/${id}/questions/${q[1]}`, { method: 'DELETE' })).status, 200);
  const chat = await load(id);
  assert.deepEqual(chat.messages.map((m) => [m.role, m.content]), [['user', 'one'], ['assistant', chat.messages[1].content]]);
  assert.equal((await call(`/api/chats/${id}/questions/${q[1] + 1}`, { method: 'DELETE' })).status, 404, 'not a question (any more)');
});

test('deleting an answer keeps its question, to be asked again', async () => {
  const { id, q } = await threeRounds();
  assert.equal((await call(`/api/chats/${id}/questions/${q[1]}/answer`, { method: 'DELETE' })).status, 200);
  const chat = await load(id);
  assert.deepEqual(chat.messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.equal(chat.messages.at(-1).content, 'two');
  assert.equal((await call(`/api/chats/${id}/questions/${q[1]}/answer`, { method: 'DELETE' })).status, 404, 'no answer left');
});

test('editing an answer rewrites it in place, and the model reads the edit from then on', async () => {
  const { id, q } = await threeRounds();
  const before = (await load(id)).messages.length;
  const ok = await call(`/api/chats/${id}/questions/${q[0]}/answer`, { method: 'PATCH', body: { content: 'EDITED ANSWER' } });
  assert.equal(ok.status, 200);
  const chat = await load(id);
  assert.equal(chat.messages.length, before, 'nothing removed, nothing run');
  assert.equal(chat.messages[1].content, 'EDITED ANSWER');
  await send(id, 'four');
  assert.ok(sent.at(-1).some((m) => m.role === 'assistant' && m.content === 'EDITED ANSWER'));
  assert.equal((await call(`/api/chats/${id}/questions/${q[0]}/answer`, { method: 'PATCH', body: { content: '  ' } })).status, 400);
});

test('a fork copies up to its point, is listed under its original, and costs nothing twice', async () => {
  const { id, q } = await threeRounds();
  const upToAnswer = await call(`/api/chats/${id}/questions/${q[1]}/fork`, { method: 'POST', body: { at: 'answer' } });
  assert.equal(upToAnswer.status, 201);
  assert.equal(upToAnswer.data.chat.parent_id, id);
  const fork = await load(upToAnswer.data.chat.id);
  assert.deepEqual(fork.messages.map((m) => m.content), (await load(id)).messages.slice(0, 4).map((m) => m.content));
  assert.ok(fork.messages.every((m) => !m.usage), 'a copied round carries no usage');
  assert.match(fork.title, /\(fork\)$/);

  const atQuestion = (await call(`/api/chats/${id}/questions/${q[1]}/fork`, { method: 'POST', body: { at: 'question' } })).data;
  assert.deepEqual((await load(atQuestion.chat.id)).messages.map((m) => m.role), ['user', 'assistant', 'user'], 'ends on the question');

  const listed = (await call('/api/chats')).data.chats;
  assert.equal(listed.find((c) => c.id === upToAnswer.data.chat.id).parent_id, id);
  assert.equal(listed.find((c) => c.id === id).parent_id, null);
  assert.equal((await call(`/api/chats/${id}/questions/${q[1]}/fork`, { method: 'POST', body: { at: 'middle' } })).status, 400);

  // The original is untouched, and deleting it leaves the fork standing.
  assert.equal((await load(id)).messages.length, 6);
  await call(`/api/chats/${id}`, { method: 'DELETE' });
  assert.equal((await load(upToAnswer.data.chat.id)).messages.length, 4);
});

test('a fork brings the attached documents along as its own copies, or leaves them out', async () => {
  const id = await send(null, 'hello');
  const up = await call(`/api/chats/${id}/documents`, { method: 'POST', body: { filename: 'notes.txt', mime: 'text/plain', dataBase64: Buffer.from('the secret word is heron').toString('base64') } });
  assert.equal(up.status, 200);
  await send(id, 'read it', { documentIds: [up.data.document.id] });
  const qs = (await call(`/api/chats/${id}/questions`)).data.seqs;

  const withFiles = (await call(`/api/chats/${id}/questions/${qs[1]}/fork`, { method: 'POST', body: { at: 'answer', withFiles: true } })).data;
  assert.equal(withFiles.documents, 1);
  const copy = await load(withFiles.chat.id);
  assert.equal(copy.documents.length, 1);
  const docId = copy.documents[0].id;
  assert.notEqual(docId, up.data.document.id, 'its own copy');
  assert.match(copy.messages[2].content, new RegExp(`id: ${docId},`), 'the note names the copy');

  const without = (await call(`/api/chats/${id}/questions/${qs[1]}/fork`, { method: 'POST', body: { at: 'answer', withFiles: false } })).data;
  const bare = await load(without.chat.id);
  assert.equal(bare.documents.length, 0);
  assert.equal(bare.messages[2].content, 'read it', 'no note about a file it cannot open');
});
