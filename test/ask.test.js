// ask_user end to end: a real server, a scripted provider that asks a
// question, and the same answer route the question card uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/index.js';
import { callAskUser } from '../src/tools/ask_tool.js';

// Each request plays the next scripted reply: an ask_user call, or text.
let script = [];
let seen = [];
const fake = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    seen.push(JSON.parse(body));
    const reply = script.shift() || { text: 'ok' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = reply.ask
      ? { tool_calls: [{ index: 0, id: `a${seen.length}`, type: 'function', function: { name: 'ask_user', arguments: JSON.stringify(reply.ask) } }] }
      : { content: reply.text };
    setTimeout(() => {
      res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }, 50);
  });
});
const port = await new Promise((r) => fake.listen(0, '127.0.0.1', () => r(fake.address().port)));

const dir = mkdtempSync(join(tmpdir(), 'tinywebui-ask-'));
process.env.TINYWEBUI_CONFIG = join(dir, 'config.json');
process.env.TINYWEBUI_MCP = join(dir, 'mcp.json');
process.env.TINYWEBUI_API_KEY = 'test-key';
process.env.TINYWEBUI_BASE_URL = `http://127.0.0.1:${port}/v1`;
process.env.TINYWEBUI_MODEL = 'fake-model';
process.env.TINYWEBUI_DB = join(dir, 'chats.db');

const { start } = await import('../src/server.js');
const srv = await start({ port: 0, host: '127.0.0.1' });
const base = `http://127.0.0.1:${srv.address().port}`;
test.after(() => { srv.shutdown?.(); srv.close(); fake.close(); });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (path, { method = 'GET', body } = {}) => {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body)
  });
  return { status: res.status, data: await res.json().catch(() => null) };
};
const setTimeoutSeconds = (s) => api('/api/config', { method: 'POST', body: { askUserTimeoutSeconds: s } });

let n = 0;
async function begin(message, replies) {
  script = replies;
  seen = [];
  const chatId = `ask${++n}`;
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chatId, message })
  });
  res.body.cancel();
  return chatId;
}

/** The run's events so far, as a rejoining tab would read them. */
async function events(chatId) {
  const res = await fetch(`${base}/api/chats/${chatId}/stream?from=0`);
  if (!res.ok) return [];
  const reader = res.body.getReader();
  let text = '';
  // Read what is buffered, then let go: the run may still be going.
  const t = setTimeout(() => reader.cancel(), 150);
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; text += new TextDecoder().decode(value); } }
  catch { /* cancelled */ }
  clearTimeout(t);
  return text.split('\n\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5)));
}

async function waitQuestion(chatId) {
  for (let i = 0; i < 60; i++) {
    const q = (await events(chatId)).filter((e) => e.type === 'question').at(-1);
    if (q) return q;
    await wait(50);
  }
  throw new Error('no question asked');
}

async function idle(chatId) {
  for (let i = 0; i < 200; i++) {
    const chat = (await api(`/api/chats/${chatId}`)).data;
    if (!chat.running) return chat;
    await wait(50);
  }
  throw new Error('still running');
}
const answer = (chatId, body) => api(`/api/chats/${chatId}/answer`, { method: 'POST', body });
const toolResult = (chat) => JSON.parse(chat.messages.find((m) => m.role === 'tool').content.split('\n\n[Tool budget')[0]);

test('an answer resumes the same run, delivered as the ask_user result', async () => {
  await setTimeoutSeconds(120);
  const id = await begin('deploy it', [{ ask: { question: 'Which environment?', choices: ['staging', 'production'] } }, { text: 'deployed' }]);
  const q = await waitQuestion(id);
  assert.equal(q.question, 'Which environment?');
  assert.deepEqual(q.choices, ['staging', 'production']);
  assert.ok(q.deadline > Date.now(), 'a deadline the countdown can show');
  assert.equal((await api(`/api/chats/${id}`)).data.running, true, 'the run waits');

  assert.equal((await answer(id, { id: q.id, answer: 'staging' })).status, 200);
  const chat = await idle(id);
  assert.deepEqual(chat.messages.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant'], 'one run, no new user turn');
  assert.deepEqual(toolResult(chat), { answered: true, answer: 'staging' });
  assert.equal(chat.messages.at(-1).content, 'deployed');
  assert.equal(seen.length, 2);
});

test('a duplicate or late answer is refused; a rejoin sees the question once', async () => {
  await setTimeoutSeconds(120);
  const id = await begin('go', [{ ask: { question: 'Name?' } }, { text: 'hi' }]);
  const q = await waitQuestion(id);
  const replay = await events(id);
  assert.equal(replay.filter((e) => e.type === 'question').length, 1, 'reload replays the pending question');

  assert.equal((await answer(id, { id: 'not-it', answer: 'x' })).status, 409);
  const [a, b] = await Promise.all([answer(id, { id: q.id, answer: 'Ann' }), answer(id, { id: q.id, answer: 'Bob' })]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409], 'exactly one answer wins');
  const chat = await idle(id);
  assert.equal(toolResult(chat).answered, true);
  assert.equal((await answer(id, { id: q.id, answer: 'late' })).status, 409);
});

test('a choice-only question refuses free text', async () => {
  await setTimeoutSeconds(120);
  const id = await begin('go', [{ ask: { question: 'Pick', choices: ['a', 'b'], allow_free_text: false } }, { text: 'done' }]);
  const q = await waitQuestion(id);
  assert.equal(q.allowFreeText, false);
  assert.equal((await answer(id, { id: q.id, answer: 'c' })).status, 400);
  assert.equal((await answer(id, { id: q.id, answer: 'b' })).status, 200);
  await idle(id);
});

test('a timeout resumes the run with the fallback, without a new user turn', async () => {
  await setTimeoutSeconds(1);
  const id = await begin('go', [{ ask: { question: 'Anyone?' } }, { text: 'assumed' }]);
  await waitQuestion(id);
  const chat = await idle(id);
  const result = toolResult(chat);
  assert.equal(result.answered, false);
  assert.equal(result.reason, 'timeout');
  assert.match(result.message, /reasonable assumptions/);
  assert.equal(chat.messages.at(-1).content, 'assumed', 'the run went on');
  assert.equal(chat.messages.filter((m) => m.role === 'user').length, 1);
  await setTimeoutSeconds(120);
});

test('"continue without me" resumes at once with the fallback', async () => {
  const id = await begin('go', [{ ask: { question: 'Anyone?' } }, { text: 'on my own' }]);
  const q = await waitQuestion(id);
  assert.equal((await answer(id, { id: q.id, skip: true })).status, 200);
  const chat = await idle(id);
  assert.equal(toolResult(chat).reason, 'skipped');
  assert.equal(chat.messages.at(-1).content, 'on my own');
});

test('stop ends the run, keeps the transcript valid, and refuses a late answer', async () => {
  const id = await begin('go', [{ ask: { question: 'Wait?' } }, { text: 'never' }]);
  const q = await waitQuestion(id);
  await api(`/api/chats/${id}/stop`, { method: 'POST' });
  const chat = await idle(id);
  assert.deepEqual(chat.messages.map((m) => m.role), ['user', 'assistant', 'tool'], 'the call still has a result');
  assert.equal(seen.length, 1, 'no model call after the stop');
  assert.equal((await answer(id, { id: q.id, answer: 'too late' })).status, 409);
});

test('steering waits behind the question instead of answering it', async () => {
  const id = await begin('go', [{ ask: { question: 'Which?' } }, { text: 'done' }]);
  const q = await waitQuestion(id);
  await api(`/api/chats/${id}/queue`, { method: 'POST', body: { id: 's1', kind: 'steer', message: 'be brief' } });
  const followup = await api(`/api/chats/${id}/queue`, { method: 'POST', body: { id: 'f1', kind: 'followup', message: 'then more' } });
  assert.equal(followup.status, 200);
  await wait(200);
  assert.equal((await api(`/api/chats/${id}`)).data.running, true, 'still waiting on the question');
  await answer(id, { id: q.id, answer: 'this one' });
  const chat = await idle(id);
  assert.deepEqual(toolResult(chat), { answered: true, answer: 'this one' });
  const shape = chat.messages.map((m) => (m.role === 'user' ? `user:${m.content}` : m.role));
  assert.deepEqual(shape, ['user:go', 'assistant', 'tool', 'user:be brief', 'assistant', 'user:then more', 'assistant']);
});

test('an automation run never waits: it gets the fallback at once', async () => {
  const id = await begin('seed', [{ text: 'ok' }]);
  await idle(id);
  const auto = (await api('/api/automations', { method: 'POST', body: {
    chatId: id, name: 'job', prompt: 'p', cron: '0 9 * * *', timezone: 'UTC'
  } })).data.automation;
  script = [{ ask: { question: 'Which city?' } }, { text: 'assumed Vienna' }];
  await api(`/api/automations/${auto.id}/trigger`, { method: 'POST' });
  await wait(100);
  const chat = await idle(id);
  const tool = chat.messages.find((m) => m.role === 'tool');
  assert.equal(JSON.parse(tool.content.split('\n\n[Tool budget')[0]).reason, 'unattended');
  assert.equal(chat.messages.at(-1).content, 'assumed Vienna');
});

test('another chat cannot answer the question', async () => {
  const id = await begin('go', [{ ask: { question: 'Mine?' } }, { text: 'done' }]);
  const q = await waitQuestion(id);
  const other = await begin('other', [{ text: 'x' }]);
  await idle(other);
  assert.equal((await answer(other, { id: q.id, answer: 'hijack' })).status, 409);
  await answer(id, { id: q.id, answer: 'yes' });
  await idle(id);
});

test('a question still pending at startup is expired, not restored', () => {
  const store = new Store(':memory:');
  const chat = store.createChat({ title: 't' });
  store.addQuestion(chat.id, { id: 'q1', question: 'still there?', deadline: Date.now() + 60000 });
  assert.equal(store.expireQuestions(), 1);
  assert.equal(store.getQuestion('q1').status, 'expired');
  assert.equal(store.settleQuestion('q1', 'answered', 'late'), false);
});

test('the tool validates its arguments and falls back with no one to ask', async () => {
  assert.match(await callAskUser({}, {}), /^Error: "question" is required/);
  assert.match(await callAskUser({ question: 'q', choices: 'a' }, {}), /^Error: "choices"/);
  const out = JSON.parse(await callAskUser({ question: 'q' }, { unattended: true }));
  assert.deepEqual([out.answered, out.reason], [false, 'unattended']);
  let asked;
  await callAskUser({ question: ' q ', choices: ['a', 'a', ''], allow_free_text: false }, {
    askUser: async (x) => { asked = x; return { answered: true, answer: 'a' }; }
  });
  assert.deepEqual(asked, { question: 'q', choices: ['a'], allowFreeText: false });
});
