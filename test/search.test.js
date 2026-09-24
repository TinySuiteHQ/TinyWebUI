// GET /api/search: full-text search over what was actually said (user and
// assistant content), never the "work" (reasoning, tool calls, tool results),
// and never a chat that is still running.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A provider that answers immediately, or hangs until told to finish -- the
// hang is what lets a test hold a chat "running" long enough to search past
// it. A flag rather than sniffing the message content: content-matching would
// race against the request body actually having arrived, and content is not
// what marks a request as the one to hold open.
let hangNext = false;
let releaseHung = null;
const fake = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const finish = () => {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'reply about budapest' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    };
    if (hangNext) { hangNext = false; releaseHung = finish; }
    else finish();
  });
});
const port = await new Promise((r) => fake.listen(0, '127.0.0.1', () => r(fake.address().port)));

const dir = mkdtempSync(join(tmpdir(), 'tinywebui-search-'));
process.env.TINYWEBUI_CONFIG = join(dir, 'config.json');
process.env.TINYWEBUI_MCP = join(dir, 'mcp.json');
process.env.TINYWEBUI_API_KEY = 'test-key';
process.env.TINYWEBUI_BASE_URL = `http://127.0.0.1:${port}/v1`;
process.env.TINYWEBUI_MODEL = 'fake-model';
process.env.TINYWEBUI_DB = join(dir, 'chats.db');

const { start } = await import('../src/server.js');
const srv = await start({ port: 0, host: '127.0.0.1' });
const base = `http://127.0.0.1:${srv.address().port}`;

const search = async (q) => (await fetch(`${base}/api/search?q=${encodeURIComponent(q)}`)).json();

/** send() only reads the first event; wait for the turn to actually settle. */
async function settled(id) {
  for (let i = 0; i < 100; i++) {
    const chat = await (await fetch(`${base}/api/chats/${id}`)).json();
    if (!chat.running) return chat;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('the turn never finished');
}

const send = async (chatId, message) => {
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chatId, message })
  });
  // Read only the first event (the chat id) rather than the whole response:
  // res.text() waits for the stream to CLOSE, and the "still running" test
  // below holds it open on purpose -- awaiting the full body there would
  // itself be the thing that never resolves, not the server.
  const { value } = await res.body.getReader().read();
  const text = new TextDecoder().decode(value);
  return JSON.parse(text.split('data:')[1].split('\n')[0]).id;
};

test('search finds a chat whether the word is in the question or the answer', async () => {
  const id = await send(null, 'how much does the budapest school cost');
  await settled(id);
  const { results } = await search('budapest');
  const hit = results.find((r) => r.chatId === id);
  assert.ok(hit, 'the chat both the question and answer belong to is found');
  assert.match(hit.snippet, /‹budapest›/i);
});

test('one result per matching chat, never one per matching message', async () => {
  const dir2 = mkdtempSync(join(tmpdir(), 'search-dedupe-'));
  const { Store, ALL_USERS } = await import('../src/store.js');
  const store = new Store(join(dir2, 'x.db'));

  // Three messages in one chat all say "lisbon" -- the question, and two
  // rounds of answer -- plus a second, unrelated chat that says it once.
  const a = store.createChat({ title: 'Lisbon trip' });
  store.addMessage(a.id, { role: 'user', content: 'best time to visit lisbon' });
  store.addMessage(a.id, { role: 'assistant', content: 'lisbon in spring is lovely, lisbon avoids the summer crowds' });

  const b = store.createChat({ title: 'Other' });
  store.addMessage(b.id, { role: 'user', content: 'is lisbon worth a weekend' });
  store.addMessage(b.id, { role: 'assistant', content: 'yes' });

  const results = store.search('lisbon', 30, ALL_USERS);
  assert.equal(results.length, 2, 'two distinct chats, not one row per matching message');
  assert.deepEqual(new Set(results.map((r) => r.chatId)), new Set([a.id, b.id]));
});

test('search does not reach into reasoning, tool calls, tool results, or narration', async () => {
  const dir2 = mkdtempSync(join(tmpdir(), 'search-store-'));
  const { Store, ALL_USERS } = await import('../src/store.js');
  const store = new Store(join(dir2, 'x.db'));
  const chat = store.createChat({ title: 'probe' });
  // A round that opens a tool call: narration + reasoning, then the tool
  // result, then a second round that actually answers. Only the last one is
  // "the answer" by the same rule the UI uses to decide what stays visible
  // outside the collapsed work.
  store.addMessage(chat.id, {
    role: 'assistant',
    content: 'narrationonly let me go check',
    reasoning: 'secretlyunique thinking nobody sees',
    tool_calls: [{ id: 't1' }]
  });
  store.addMessage(chat.id, { role: 'tool', tool_call_id: 't1', content: 'giantscrapeblob from a page' });
  store.addMessage(chat.id, { role: 'assistant', content: 'the visible answer' });

  assert.deepEqual(store.search('secretlyunique', 30, ALL_USERS), [], 'reasoning is the work, not the conversation');
  assert.deepEqual(store.search('giantscrapeblob', 30, ALL_USERS), [], 'a tool result is the work, not the conversation');
  assert.deepEqual(store.search('narrationonly', 30, ALL_USERS), [], 'narration superseded by a later round is the work too');
  assert.equal(store.search('visible', 30, ALL_USERS).length, 1, 'the answer that actually stood is still found');
  store.close();
});

test('a chat that is still running is left out of the results', async () => {
  hangNext = true;
  const id = await send(null, 'budapest placeholder while running');
  // send() only reads the first SSE event (the chat id); the POST to the fake
  // provider is in flight behind it, so give it a moment to actually land and
  // start hanging before asserting anything about it.
  for (let i = 0; i < 40 && !releaseHung; i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(releaseHung, 'the fake provider is holding the round open');

  // The question is already stored -- the running chat has to be excluded
  // by its own state, not by there being nothing to find yet.
  let hit = (await search('budapest')).results.find((r) => r.chatId === id);
  assert.equal(hit, undefined, 'a running chat is excluded even though the word is already in its content');

  releaseHung();
  releaseHung = null;
  for (let i = 0; i < 40 && !hit; i++) {
    await new Promise((r) => setTimeout(r, 25));
    hit = (await search('budapest')).results.find((r) => r.chatId === id);
  }
  assert.ok(hit, 'and once it settles, the same search finds it');
});

test('an empty query returns no results rather than everything', async () => {
  assert.deepEqual((await search('')).results, []);
  assert.deepEqual((await search('   ')).results, []);
});

test.after(async () => { await srv.shutdown(); fake.close(); });
