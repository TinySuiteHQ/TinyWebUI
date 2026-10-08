// Steering and follow-up input sent while a turn runs, against a real server
// and a slow scripted provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Each request plays the next scripted reply (text, or a expand_context call),
// slowly enough to queue something while it streams. Bodies are recorded.
let script = [];
let seen = [];
const fake = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    seen.push(JSON.parse(body));
    const reply = script.shift() || { text: 'ok' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = reply.call
      ? { tool_calls: [{ index: 0, id: `t${seen.length}`, type: 'function', function: { name: 'expand_context', arguments: '{}' } }] }
      : { content: reply.text };
    setTimeout(() => {
      res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }, 250);
  });
});
const port = await new Promise((r) => fake.listen(0, '127.0.0.1', () => r(fake.address().port)));

const dir = mkdtempSync(join(tmpdir(), 'tinywebui-'));
process.env.TINYWEBUI_CONFIG = join(dir, 'config.json');
process.env.TINYWEBUI_MCP = join(dir, 'mcp.json');
writeFileSync(process.env.TINYWEBUI_MCP, '{ "mcpServers": {} }'); // no servers, not the TinySuite defaults
process.env.TINYWEBUI_API_KEY = 'test-key';
process.env.TINYWEBUI_BASE_URL = `http://127.0.0.1:${port}/v1`;
process.env.TINYWEBUI_MODEL = 'fake-model';
process.env.TINYWEBUI_DB = join(dir, 'chats.db');

const { start } = await import('../src/server.js');
const srv = await start({ port: 0, host: '127.0.0.1', config: { authMode: 'none' } });
const base = `http://127.0.0.1:${srv.address().port}`;
test.after(() => { srv.shutdown?.(); srv.close(); fake.close(); });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (path, { method = 'GET', body } = {}) => {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body)
  });
  return { status: res.status, data: await res.json().catch(() => null) };
};
let n = 0;
const queue = (chatId, kind, message, id = `q${++n}`) =>
  api(`/api/chats/${chatId}/queue`, { method: 'POST', body: { id, kind, message } });

/** Starts a turn without reading its stream. */
async function begin(message, replies) {
  script = replies;
  seen = [];
  const chatId = `chat${++n}`;
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chatId, message })
  });
  res.body.cancel();
  return chatId;
}

async function idle(chatId) {
  for (let i = 0; i < 100; i++) {
    const chat = (await api(`/api/chats/${chatId}`)).data;
    if (!chat.running) return chat;
    await wait(50);
  }
  throw new Error('still running');
}
const shape = (chat) => chat.messages.map((m) => (m.role === 'user' ? `user:${m.content}` : m.role));

test('a steering message lands after the running tool batch, before the next model call', async () => {
  const id = await begin('go', [{ call: true }, { text: 'answer' }]);
  await wait(100);
  assert.equal((await queue(id, 'steer', "don't modify anything")).status, 200);
  const chat = await idle(id);

  assert.deepEqual(shape(chat), ['user:go', 'assistant', 'tool', "user:don't modify anything", 'assistant']);
  assert.equal(seen.length, 2, 'one run, no extra model call');
  assert.equal(seen[1].messages.at(-1).content, "don't modify anything");
  assert.equal(seen[1].messages.at(-2).role, 'tool', 'tool calls and results stay paired');
  assert.deepEqual(chat.queued, []);
});

test('a follow-up waits for the answer, then starts its own turn', async () => {
  const id = await begin('first', [{ text: 'one' }, { text: 'two' }]);
  await wait(100);
  await queue(id, 'followup', 'after that, compare it with X');
  const chat = await idle(id);
  assert.deepEqual(shape(chat), ['user:first', 'assistant', 'user:after that, compare it with X', 'assistant']);
  assert.equal(chat.messages.at(-1).content, 'two');
});

test('several queued messages keep their order: steering in the run, follow-ups one turn each', async () => {
  const id = await begin('go', [{ call: true }, { text: 'a' }, { text: 'b' }, { text: 'c' }]);
  await wait(50);
  await queue(id, 'followup', 'f1');
  await queue(id, 'steer', 's1');
  await queue(id, 'steer', 's2');
  await queue(id, 'followup', 'f2');
  const chat = await idle(id);
  assert.deepEqual(shape(chat), [
    'user:go', 'assistant', 'tool', 'user:s1', 'user:s2', 'assistant', 'user:f1', 'assistant', 'user:f2', 'assistant'
  ]);
});

test('a retried submit is not queued twice, and a reload sees the queue and each message once', async () => {
  const id = await begin('go', [{ call: true }, { text: 'done' }]);
  await wait(50);
  await queue(id, 'followup', 'later', 'same-id');
  await queue(id, 'followup', 'later', 'same-id');
  const mid = (await api(`/api/chats/${id}`)).data;
  assert.equal(mid.running, true);
  assert.deepEqual(mid.queued.map((q) => q.content), ['later']);

  await idle(id);
  // Rejoining the follow-up's run replays its user message from events only.
  const chat = (await api(`/api/chats/${id}`)).data;
  assert.equal(chat.messages.filter((m) => m.content === 'later').length, 1);
});

test('a queued message can be withdrawn before delivery', async () => {
  const id = await begin('go', [{ text: 'done' }]);
  await wait(50);
  await queue(id, 'followup', 'never mind', 'drop-me');
  assert.equal((await api(`/api/chats/${id}/queue/drop-me`, { method: 'DELETE' })).status, 200);
  const chat = await idle(id);
  assert.deepEqual(shape(chat), ['user:go', 'assistant']);
});

test('stop delivers nothing and keeps the queue for the composer to take back', async () => {
  const id = await begin('go', [{ call: true }, { text: 'never' }]);
  await wait(50);
  await queue(id, 'steer', 'steer me');
  await queue(id, 'followup', 'follow me');
  await api(`/api/chats/${id}/stop`, { method: 'POST' });
  const chat = await idle(id);
  assert.ok(!chat.messages.some((m) => /me$/.test(m.content || '')), 'nothing was delivered');
  assert.deepEqual(chat.queued.map((q) => q.content), ['steer me', 'follow me']);
  await wait(400);
  assert.equal((await api(`/api/chats/${id}`)).data.running, false, 'and no follow-up started');
});

test('queueing needs a running interactive turn', async () => {
  const id = await begin('go', [{ text: 'done' }]);
  await idle(id);
  assert.equal((await queue(id, 'steer', 'too late')).status, 409);
});

test('an automation run takes no interactive input', async () => {
  const id = await begin('seed', [{ text: 'ok' }]);
  await idle(id);
  const auto = (await api('/api/automations', { method: 'POST', body: {
    chatId: id, name: 'job', prompt: 'p', cron: '0 9 * * *', timezone: 'UTC'
  } })).data.automation;
  script = [{ call: true }, { text: 'auto done' }];
  await api(`/api/automations/${auto.id}/trigger`, { method: 'POST' });
  await wait(50);
  assert.equal((await queue(id, 'steer', 'mine')).status, 409);
  const chat = await idle(id);
  assert.ok(!chat.messages.some((m) => m.content === 'mine'));
});

test('an automation run is stored with its origin, and the model still gets the prompt', async () => {
  const id = await begin('seed', [{ text: 'ok' }]);
  await idle(id);
  const auto = (await api('/api/automations', { method: 'POST', body: {
    chatId: id, name: 'digest', prompt: 'summarise the inbox', cron: '0 9 * * 1-5', timezone: 'Europe/Vienna'
  } })).data.automation;
  script = [{ text: 'summary' }];
  seen = [];
  await api(`/api/automations/${auto.id}/trigger`, { method: 'POST' });
  const chat = await idle(id);
  const run = chat.messages.find((m) => m.origin);
  assert.deepEqual(
    { type: run.origin.type, trigger: run.origin.trigger, name: run.origin.name, cron: run.origin.cron, prompt: run.origin.prompt },
    { type: 'automation', trigger: 'manual', name: 'digest', cron: '0 9 * * 1-5', prompt: 'summarise the inbox' }
  );
  assert.equal(run.role, 'user');
  assert.ok(!chat.messages.find((m) => m.content === 'seed').origin, 'typed messages carry no origin');
  const sent = seen[0].messages.filter((m) => m.role === 'user').at(-1);
  assert.match(sent.content, /summarise the inbox/);
  assert.ok(!('origin' in sent), 'origin never reaches the model');
});
