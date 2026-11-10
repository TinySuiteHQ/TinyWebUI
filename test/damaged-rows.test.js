// One damaged row must not take its chat down: a JSON column that does not
// parse, or parses to the wrong shape, is left off, and the chat still opens,
// still counts in Usage, and still takes a new turn.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sent = [];
const fake = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    if (req.url.endsWith('/models')) { res.writeHead(404); return res.end(); }
    sent.push(JSON.parse(body).messages);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'still here' } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 2 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
});
const port = await new Promise((r) => fake.listen(0, '127.0.0.1', () => r(fake.address().port)));

const dir = mkdtempSync(join(tmpdir(), 'tinywebui-damaged-'));
writeFileSync(join(dir, 'mcp.json'), '{ "mcpServers": {} }');
const dbPath = join(dir, 'chats.db');
const { start } = await import('../server/server.ts');
const srv = await start({
  port: 0, host: '127.0.0.1', configFile: false, mcpServers: {}, dbPath,
  config: { authMode: 'local', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', model: 'fake-model', retrieval: { mode: 'lexical' } }
});
test.after(async () => { await srv.shutdown(); fake.close(); });
const base = `http://127.0.0.1:${srv.address().port}`;

// Written behind the server's back, the way a bad import, a disk error or a hand edit would.
const { Store } = await import('../server/store/index.ts');
const side = new Store(dbPath);
const chat = side.chats.create({ id: 'damaged', title: 'Damaged' });
side.messages.add(chat.id, { role: 'user', content: 'first question' });
side.messages.add(chat.id, { role: 'assistant', content: 'an answer', model: 'fake-model', usage: { prompt_tokens: 3, completion_tokens: 1 } });
const corrupt = side.db.prepare('UPDATE messages SET tool_calls_json = ?, usage_json = ?, origin_json = ?, images_json = ? WHERE chat_id = ? AND seq = ?');
corrupt.run('{not json', '"just text"', '[1,2]', '{"not":"a list"}', chat.id, 1);
side.db.prepare('UPDATE messages SET tool_calls_json = ? WHERE chat_id = ? AND seq = ?').run('[{"oops":true}]', chat.id, 0);
side.close();

test('a chat with damaged rows still opens, with the bad fields left off', async () => {
  const res = await fetch(`${base}/api/chats/damaged`);
  assert.equal(res.status, 200);
  const { messages } = await res.json();
  assert.deepEqual(messages.map((m) => m.content), ['first question', 'an answer']);
  assert.equal(messages[1].tool_calls, undefined);
  assert.equal(messages[1].usage, undefined);
  assert.equal(messages[0].tool_calls, undefined, 'a call without an id or a function is not one');
});

test('the Usage page still loads', async () => {
  assert.equal((await fetch(`${base}/api/usage`)).status, 200);
});

test('and the chat takes a new turn, sending the model only what is sound', async () => {
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chatId: 'damaged', message: 'second question' })
  });
  const text = await res.text();
  assert.match(text, /still here/);
  const wire = sent.at(-1);
  assert.ok(wire.every((m) => !m.tool_calls), 'no malformed tool calls go to the provider');
  assert.equal(wire.at(-1).content, 'second question');
});
