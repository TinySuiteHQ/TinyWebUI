// Drives a real server: start a turn, hang up on it, and check the answer
// still lands and the chat reports itself as running while it does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A stand-in provider: streams a couple of tokens, slowly, so the client has
// time to disconnect mid-turn.
const fake = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  let i = 0;
  const words = ['the ', 'answer ', 'survived'];
  const tick = setInterval(() => {
    if (i < words.length) {
      chunk({ choices: [{ delta: { content: words[i++] } }] });
    } else {
      clearInterval(tick);
      chunk({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3 } });
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }, 120);
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

test('a turn outlives the client that started it', async () => {
  const ac = new AbortController();
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'does this survive?' }),
    signal: ac.signal
  });

  // Read just far enough to learn the chat id, then hang up mid-turn.
  const reader = res.body.getReader();
  const { value } = await reader.read();
  const chatId = JSON.parse(new TextDecoder().decode(value).split('data:')[1].split('\n')[0]).id;
  assert.ok(chatId);
  ac.abort();

  // While it runs, the chat says so -- that is what draws the sidebar dot.
  const listed = await (await fetch(`${base}/api/chats`)).json();
  assert.equal(listed.chats.find((c) => c.id === chatId).running, true);

  // Nobody is watching. The answer should land anyway.
  await new Promise((r) => setTimeout(r, 900));

  const after = await (await fetch(`${base}/api/chats/${chatId}`)).json();
  assert.equal(after.running, false, 'the turn finished');
  const assistant = after.messages.filter((m) => m.role === 'assistant');
  assert.equal(assistant.at(-1).content, 'the answer survived', 'written to the store with no client attached');
});

test('a second viewer can rejoin a turn already in flight and replay it whole', async () => {
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'rejoin me' })
  });
  const reader = res.body.getReader();
  const { value } = await reader.read();
  const chatId = JSON.parse(new TextDecoder().decode(value).split('data:')[1].split('\n')[0]).id;

  // A reload mid-turn: the stored transcript is cut back to the turn's start,
  // and the events carry the rest.
  const mid = await (await fetch(`${base}/api/chats/${chatId}`)).json();
  assert.equal(mid.running, true);
  assert.equal(mid.messages.at(-1).role, 'user', 'nothing of the live turn is in the replay yet');

  const text = await (await fetch(`${base}/api/chats/${chatId}/stream?from=0`)).text();
  assert.match(text, /"type":"chat"/, 'the backlog replays from the top');
  assert.match(text, /survived/, 'and then follows the turn to its end');
});

test.after(() => { srv.close(); fake.close(); });
