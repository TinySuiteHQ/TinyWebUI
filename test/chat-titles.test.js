// A new chat is named by its model from the first message, beside the first
// turn; a rename made meanwhile wins, and the setting turns it off.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { Store } from '../server/store/index.ts';
import { DEFAULTS } from '../server/config/config.ts';
import { createRuns } from '../server/chat/runs.ts';
import { TITLE_PROMPT, cleanTitle, writeTitle } from '../server/harness/title.ts';

/** A provider that answers a title request with `title` and anything else with "ok". */
async function provider({ title = 'Paris trip planning', delay = 0 } = {}) {
  const turns = [];
  const titles = [];
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const b = JSON.parse(body);
      const isTitle = b.messages[0].content === TITLE_PROMPT;
      (isTitle ? titles : turns).push(b);
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: isTitle ? title : 'ok' }, finish_reason: 'stop' }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 30, completion_tokens: 5 } })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      }, isTitle ? delay : 0);
    });
  });
  const port = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
  return { turns, titles, baseUrl: `http://127.0.0.1:${port}/v1`, close: () => srv.close() };
}

/** Runs one turn of `chat` to its end and returns what it streamed. */
function runTurn(store, chat, p, { cfg = {}, titleFrom = null } = {}) {
  const app = {
    store, cfg: { ...DEFAULTS, baseUrl: p.baseUrl, apiKey: 'k', model: 'm', ...cfg },
    hub: { instructionsBlock: () => '', call: async () => '' },
    retrieval: { ingest: async () => {} }, onRunIdle: () => {}
  };
  const runs = createRuns(app);
  return new Promise((resolve) => {
    const run = runs.start({ chat, tools: [], titleFrom, onFinish: () => resolve(run.events) });
  });
}

test('a reply is cut down to its title', () => {
  assert.equal(cleanTitle('"Planning a trip to Paris."'), 'Planning a trip to Paris');
  assert.equal(cleanTitle('Title: **Weekend hiking plan**\nextra line'), 'Weekend hiking plan');
  assert.equal(cleanTitle('<think>the user wants a name</think>\n\nBudget spreadsheet help'), 'Budget spreadsheet help');
  assert.equal(cleanTitle('# Rust lifetimes'), 'Rust lifetimes');
  assert.equal(cleanTitle('<think>still thinking when the cap hit'), '');
  assert.equal(cleanTitle('   '), '');
  assert.ok(cleanTitle('word '.repeat(40)).length <= 80);
});

test('the title request carries only the first message, no tools and no thinking', async () => {
  const p = await provider();
  try {
    const usage = [];
    const title = await writeTitle({
      cfg: { baseUrl: p.baseUrl, apiKey: 'k', model: 'm', extraBody: { tools: [{}], tool_choice: 'required' }, thinkingLevel: 'high' },
      message: 'Help me plan three days in Paris in May', emit: () => {}, onUsage: (u) => usage.push(u)
    });
    assert.equal(title, 'Paris trip planning');
    const [req] = p.titles;
    assert.equal(req.messages.length, 2);
    assert.equal(req.messages[1].content, 'Help me plan three days in Paris in May');
    assert.equal(req.tools, undefined);
    assert.equal(req.tool_choice, undefined);
    assert.equal(usage.length, 1, 'billed usage is reported');
  } finally { p.close(); }
});

test('a new chat is renamed from its first message and the page is told in the same stream', async () => {
  const p = await provider();
  const store = new Store(':memory:');
  try {
    const chat = store.chats.create({ title: 'Help me plan three days in Paris in May' });
    store.messages.add(chat.id, { role: 'user', content: 'Help me plan three days in Paris in May' });
    const events = await runTurn(store, chat, p, { titleFrom: 'Help me plan three days in Paris in May' });
    assert.equal(store.chats.byId(chat.id).title, 'Paris trip planning');
    assert.ok(events.some((e) => e.type === 'chat' && e.title === 'Paris trip planning'));
    assert.equal(p.turns.length, 1, 'the turn itself ran as usual');
  } finally { p.close(); store.close?.(); }
});

test('a rename made while the title was on its way is kept', async () => {
  const p = await provider({ delay: 150 });
  const store = new Store(':memory:');
  try {
    const chat = store.chats.create({ title: 'first message' });
    store.messages.add(chat.id, { role: 'user', content: 'first message' });
    const done = runTurn(store, chat, p, { titleFrom: 'first message' });
    setTimeout(() => store.chats.rename(chat.id, 'My own name', null), 50);
    await done;
    assert.equal(store.chats.byId(chat.id).title, 'My own name');
  } finally { p.close(); store.close?.(); }
});

test('with autoTitle off no title is asked for, and later turns never ask', async () => {
  const p = await provider();
  const store = new Store(':memory:');
  try {
    const chat = store.chats.create({ title: 'first message' });
    store.messages.add(chat.id, { role: 'user', content: 'first message' });
    await runTurn(store, chat, p, { titleFrom: 'first message', cfg: { autoTitle: false } });
    await runTurn(store, chat, p, { titleFrom: null });
    assert.equal(p.titles.length, 0);
    assert.equal(store.chats.byId(chat.id).title, 'first message');
  } finally { p.close(); store.close?.(); }
});

test('pinning keeps a chat at the top of the list without counting as activity', () => {
  const store = new Store(':memory:');
  const old = store.chats.create({ title: 'old', createdAt: 1000 });
  const fresh = store.chats.create({ title: 'fresh' });
  const before = store.chats.byId(old.id).updated_at;
  assert.ok(store.chats.pin(old.id, true, null));
  assert.equal(store.chats.byId(old.id).updated_at, before);
  // Even past the limit, a pinned chat is listed.
  const [first] = store.chats.list(1, null);
  assert.equal(first.id, old.id);
  assert.ok(first.pinned_at > 0);
  store.chats.pin(old.id, false, null);
  assert.equal(store.chats.byId(old.id).pinned_at, null);
  assert.equal(store.chats.list(1, null)[0].id, fresh.id);
});
