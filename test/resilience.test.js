// Failures after the request succeeded: a stream that breaks, a tool server that dies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Store } from '../src/store/index.js';
import { runChat } from '../src/chat/llm.js';
import { McpHub } from '../src/mcp.js';

const MORTAL = join(dirname(fileURLToPath(import.meta.url)), '..', 'test-fixtures', 'mortal-mcp-server.mjs');
const sse = (o) => `data: ${JSON.stringify(o)}\n\n`;

/** A provider whose Nth response is scripted by `plan[n]`. */
function provider(plan) {
  let n = 0;
  const srv = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const step = plan[Math.min(n++, plan.length - 1)];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      step(res);
    });
  });
  return { srv, count: () => n };
}

const answer = (res) => {
  res.write(sse({ choices: [{ delta: { content: 'recovered' } }] }));
  res.write(sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } }));
  res.end('data: [DONE]\n\n');
};

async function run(plan) {
  const { srv, count } = provider(plan);
  const port = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'res-')), 'r.db'));
  const chat = store.createChat({ title: 't' });
  store.addMessage(chat.id, { role: 'user', content: 'hi' });
  const events = [];
  try {
    await runChat({
      cfg: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', model: 'm', systemPrompt: 's', maxToolRounds: 1 },
      chatId: chat.id, store, tools: [], hub: null,
      emit: (ev) => events.push(ev), signal: new AbortController().signal
    });
  } catch (err) {
    events.push({ type: 'error', error: err.message });
  }
  srv.close();
  const stored = store.messages(chat.id).filter((m) => m.role === 'assistant');
  return { events, stored, requests: count() };
}

test('an in-band error before any text re-runs the round', async () => {
  const { events, stored, requests } = await run([
    (res) => res.end(sse({ error: { message: 'upstream overloaded' } })),
    answer
  ]);
  assert.equal(requests, 2);
  assert.ok(events.some((e) => e.type === 'notice' && /upstream overloaded.*retrying the round/.test(e.text)));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].content, 'recovered', 'no empty-reply placeholder is stored');
});

test('a dropped connection before any text re-runs the round', async () => {
  const { stored, requests } = await run([
    (res) => { res.write(sse({ choices: [{ delta: { reasoning: 'hmm' } }] })); res.socket.destroy(); },
    answer
  ]);
  assert.equal(requests, 2);
  assert.equal(stored[0].content, 'recovered');
});

test('a failure after text reached the user ends the turn without storing half a reply', async () => {
  const { events, stored, requests } = await run([
    (res) => { res.write(sse({ choices: [{ delta: { content: 'half' } }] })); res.end(sse({ error: { message: 'gone' } })); }
  ]);
  assert.equal(requests, 1);
  assert.match(events.find((e) => e.type === 'error').error, /broke off part-way \(gone\)/);
  assert.equal(stored.length, 0);
});

test('a reply cut off by the output cap says so', async () => {
  const { events } = await run([(res) => {
    res.write(sse({ choices: [{ delta: { content: 'trunc' } }] }));
    res.write(sse({ choices: [{ delta: {}, finish_reason: 'length' }] }));
    res.end('data: [DONE]\n\n');
  }]);
  assert.ok(events.some((e) => e.type === 'notice' && /output token limit/.test(e.text)));
});

async function mortalHub(env = {}) {
  const hub = new McpHub({ mortal: { command: process.execPath, args: [MORTAL], env } });
  await hub.connect();
  return hub;
}

test('a server that died between calls is restarted, with the same tool block', async (t) => {
  const hub = await mortalHub();
  t.after(() => hub.close());
  const before = JSON.stringify(hub.tools);
  const pid1 = await hub.call('mortal__pid');
  process.kill(Number(pid1));
  await new Promise((r) => setTimeout(r, 300));
  const pid2 = await hub.call('mortal__pid');
  assert.match(pid2, /^\d+$/);
  assert.notEqual(pid2, pid1);
  assert.equal(JSON.stringify(hub.tools), before);
});

test('a write that killed its server is not repeated', async (t) => {
  const hub = await mortalHub();
  t.after(() => hub.close());
  const out = await hub.call('mortal__die');
  assert.match(out, /restarted during this call.*may or may not have taken effect/);
  assert.match(await hub.call('mortal__pid'), /^\d+$/, 'the server is back for the next call');
});

test('a repeatable call that killed its server is retried once on the new one', async (t) => {
  const hub = await mortalHub();
  t.after(() => hub.close());
  // The replacement process must survive the same call.
  hub.servers.mortal.env = { MORTAL_SURVIVED: '1' };
  assert.equal(await hub.call('mortal__die_readonly'), 'ok');
});
