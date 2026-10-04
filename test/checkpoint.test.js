// LLM checkpoints: the window's dropped turns become a system-prompt summary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { Store, ALL_USERS } from '../src/store/index.js';
import { runChat } from '../src/chat/llm.js';
import { CHECKPOINT_PROMPT, checkpointSource } from '../src/harness/checkpoint.js';

const GOOD = ['Objective', 'User constraints', 'Decisions', 'Verified findings',
  'Assumptions and uncertainty', 'Unfinished work'].map((h) => `## ${h}\nNone`).join('\n')
  .replace('## User constraints\nNone', '## User constraints\nFreehold only; code HOUSE-7319.');

async function provider({ summary = GOOD } = {}) {
  const chats = [];
  const summaries = [];
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const b = JSON.parse(body);
      const isSummary = b.messages[0].content === CHECKPOINT_PROMPT;
      (isSummary ? summaries : chats).push(b);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const text = isSummary ? summary : 'ok';
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 20, cost: 0.01 } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  const port = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
  return { chats, summaries, baseUrl: `http://127.0.0.1:${port}/v1`, close: () => srv.close() };
}

function longChat(store, turns = 6) {
  const chat = store.chats.create({ title: 't' });
  store.messages.add(chat.id, { role: 'user', content: 'Constraint: freehold only, code HOUSE-7319. ' + 'x'.repeat(400) });
  store.messages.add(chat.id, { role: 'assistant', content: 'noted ' + 'y'.repeat(400) });
  for (let i = 1; i < turns; i++) {
    store.messages.add(chat.id, { role: 'user', content: `turn ${i} ` + 'x'.repeat(400) });
    store.messages.add(chat.id, { role: 'assistant', content: `reply ${i} ` + 'y'.repeat(400) });
  }
  store.messages.add(chat.id, { role: 'user', content: 'latest question' });
  return chat;
}

async function turn(store, chat, p, cfg) {
  const events = [];
  await runChat({
    cfg: { baseUrl: p.baseUrl, apiKey: 'k', model: 'm', systemPrompt: 'sys', maxHistoryTokens: 600, keepTurns: 1, ...cfg },
    chatId: chat.id, store, tools: [], hub: { instructionsBlock: () => '', call: async () => '' },
    emit: (e) => events.push(e), signal: new AbortController().signal
  });
  return events;
}

test('with llmCompaction off the window drops turns without a summary request', async () => {
  const p = await provider();
  const store = new Store(':memory:');
  const chat = longChat(store);
  try { await turn(store, chat, p, { llmCompaction: false }); } finally { p.close(); }
  assert.equal(p.summaries.length, 0);
  assert.ok(!p.chats[0].messages[0].content.includes('Earlier conversation (summary)'));
  assert.equal(store.chats.byId(chat.id).checkpoint_json, null);
});

test('with llmCompaction the dropped turns are summarised into the system prompt', async () => {
  const p = await provider();
  const store = new Store(':memory:');
  const chat = longChat(store);
  try {
    await turn(store, chat, p, { llmCompaction: true });
    const sent = p.chats[0].messages;
    assert.match(sent[0].content, /Earlier conversation \(summary\)[\s\S]*HOUSE-7319/);
    assert.ok(!JSON.stringify(sent.slice(1)).includes('Constraint: freehold'), 'the summarised turns are gone');
    assert.ok(sent.slice(1).every((m) => m.role !== 'system'), 'no message injected into the conversation');
    assert.match(p.summaries[0].messages[1].content, /Constraint: freehold only/);
    assert.equal(p.summaries[0].tools, undefined);

    const stats = store.usage.statistics(ALL_USERS);
    assert.deepEqual(stats.auxiliary, { requests: 1, cost: 0.01 });
    assert.equal(stats.rounds, 7, 'six seeded replies and this one; the summary is not a round');

    // The next turn reuses it until the window has to move again.
    store.messages.add(chat.id, { role: 'user', content: 'and another' });
    await turn(store, chat, p, { llmCompaction: true });
    assert.equal(p.summaries.length, 1);
    assert.equal(p.chats[1].messages[0].content, sent[0].content, 'same system bytes, so the cache holds');
  } finally { p.close(); }
});

test('a summary not in checkpoint form is not stored; the window still moves', async () => {
  const p = await provider({ summary: 'Sure! Here is what happened.' });
  const store = new Store(':memory:');
  const chat = longChat(store);
  let events;
  try { events = await turn(store, chat, p, { llmCompaction: true }); } finally { p.close(); }
  const c = store.chats.byId(chat.id);
  assert.equal(c.checkpoint_json, null);
  assert.ok(c.window_seq > 0);
  assert.ok(events.some((e) => /Could not summarise/.test(e.text || '')));
  assert.equal(store.usage.statistics(ALL_USERS).auxiliary.requests, 1, 'billed even though rejected');
});

test('rewinding to before the cut removes the checkpoint with the window', async () => {
  const p = await provider();
  const store = new Store(':memory:');
  const chat = longChat(store);
  try { await turn(store, chat, p, { llmCompaction: true }); } finally { p.close(); }
  const { window_seq } = store.chats.byId(chat.id);
  store.chats.truncateFrom(chat.id, window_seq);
  const c = store.chats.byId(chat.id);
  assert.equal(c.checkpoint_json, null);
  assert.equal(c.window_seq, -1);
});

test('the summary source cuts long tool results and keeps their artifact id', () => {
  const src = checkpointSource({ previous: 'old summary', rows: [
    { role: 'assistant', content: null, tool_calls: [{ function: { name: 'search', arguments: '{"q":"a"}' } }] },
    { role: 'tool', content: 'z'.repeat(5000), artifact_id: 'art1' }
  ] });
  assert.match(src, /# Previous checkpoint\nold summary/);
  assert.match(src, /search\(\{"q":"a"\}\)/);
  assert.match(src, /artifact art1/);
  assert.match(src, /3500 more chars/);
  assert.ok(src.length < 2500);
});

test('llmCompaction is on by default', async () => {
  const { DEFAULTS } = await import('../src/config/config.js');
  assert.equal(DEFAULTS.llmCompaction, true);
});
