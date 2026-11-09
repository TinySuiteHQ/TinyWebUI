// A provider that goes quiet: before its reply starts, the request is retried;
// in the middle of it, the turn ends with an error instead of hanging until
// someone presses Stop (or forever, for an automation nobody watches).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.TINYWEBUI_STREAM_STALL_MS = '400';
const { Store } = await import('../server/store/index.ts');
const { runChat } = await import('../server/chat/llm.ts');

const sse = (o) => `data: ${JSON.stringify(o)}\n\n`;

async function run(plan) {
  let n = 0;
  const srv = createServer((req, res) => {
    req.resume();
    req.on('end', () => plan[Math.min(n++, plan.length - 1)](res));
  });
  const port = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'stall-')), 's.db'));
  const chat = store.chats.create({ title: 't' });
  store.messages.add(chat.id, { role: 'user', content: 'hi' });
  const events = [];
  const started = Date.now();
  try {
    await runChat({
      cfg: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', model: 'm', systemPrompt: 's', maxToolRounds: 1 },
      chatId: chat.id, store, tools: [], hub: null,
      emit: (ev) => events.push(ev), signal: new AbortController().signal
    });
  } catch (err) {
    events.push({ type: 'error', error: err.message });
  }
  srv.closeAllConnections();
  srv.close();
  return { events, requests: n, ms: Date.now() - started, store, chatId: chat.id };
}

const answer = (res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(sse({ choices: [{ delta: { content: 'recovered' } }] }));
  res.write(sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } }));
  res.end('data: [DONE]\n\n');
};

test('a reply that never starts is given up and retried', async () => {
  const r = await run([() => { /* accepts the request, never answers */ }, answer]);
  assert.equal(r.requests, 2);
  const stored = r.store.messages.list(r.chatId).filter((m) => m.role === 'assistant');
  assert.equal(stored.at(-1).content, 'recovered');
});

test('a reply that goes silent part-way ends the turn with an error, not a hang', async () => {
  const r = await run([(res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sse({ choices: [{ delta: { content: 'half an ans' } }] }));
    // ...and nothing more, with the connection left open.
  }]);
  const error = r.events.find((e) => e.type === 'error');
  assert.ok(error, 'the turn reports an error');
  assert.match(error.error, /sent nothing/);
  assert.ok(r.ms < 10_000, `it ended promptly (${r.ms} ms)`);
});
