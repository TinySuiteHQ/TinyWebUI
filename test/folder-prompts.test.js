// A folder's own instructions: set when it is made or later, kept through a
// rename (its chats move with it), and added to the system prompt of every
// turn in its chats -- only theirs, and only while they are in it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
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
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 1 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
});
const port = await new Promise((r) => fake.listen(0, '127.0.0.1', () => r(fake.address().port)));

const dir = mkdtempSync(join(tmpdir(), 'tinywebui-folders-'));
const { start } = await import('../server/server.ts');
const srv = await start({
  port: 0, host: '127.0.0.1', configFile: false, mcpServers: {}, dbPath: join(dir, 'chats.db'),
  config: { authMode: 'local', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', model: 'fake-model', systemPrompt: 'BASE PROMPT', retrieval: { mode: 'lexical' } }
});
test.after(async () => { await srv.shutdown(); fake.close(); });
const base = `http://127.0.0.1:${srv.address().port}`;

const call = async (path, { method = 'GET', body } = {}) => {
  const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => null) };
};
const send = async (chatId, message) => {
  const res = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chatId, message }) });
  const text = await res.text();
  return JSON.parse(text.split('data:')[1].split('\n')[0]).id;
};
const system = () => sent.at(-1).find((m) => m.role === 'system').content;

test('a folder keeps its instructions, and a rename takes its chats and instructions along', async () => {
  assert.equal((await call('/api/folders', { method: 'POST', body: { name: 'Thesis', prompt: 'Cite sources.' } })).status, 200);
  assert.equal((await call('/api/folders')).data.prompts.Thesis, 'Cite sources.');
  assert.ok((await call('/api/folders')).data.folders.includes('Thesis'), 'names stay a plain list');

  const id = await send(null, 'hello');
  await call(`/api/chats/${id}/organize`, { method: 'POST', body: { folder: 'Thesis' } });
  const renamed = await call('/api/folders', { method: 'PATCH', body: { name: 'Thesis', rename: 'PhD', prompt: 'Cite sources, APA style.' } });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.data.folder, 'PhD');
  const after = (await call('/api/folders')).data;
  assert.ok(!after.folders.includes('Thesis') && after.folders.includes('PhD'));
  assert.equal(after.prompts.PhD, 'Cite sources, APA style.');
  assert.equal((await call('/api/chats')).data.chats.find((c) => c.id === id).folder, 'PhD', 'its chats moved with it');

  await call('/api/folders', { method: 'POST', body: { name: 'Other' } });
  assert.equal((await call('/api/folders', { method: 'PATCH', body: { name: 'PhD', rename: 'Other' } })).status, 409);
  assert.equal((await call('/api/folders', { method: 'PATCH', body: { name: 'Nope', prompt: 'x' } })).status, 404);
  assert.equal((await call('/api/folders', { method: 'PATCH', body: { name: 'PhD', rename: '  ' } })).status, 400);
  assert.equal((await call('/api/folders', { method: 'PATCH', body: { name: 'PhD', prompt: 5 } })).status, 400);
});

test("a folder's instructions join the system prompt of its chats' turns, and only theirs", async () => {
  await call('/api/folders', { method: 'POST', body: { name: 'Recipes', prompt: 'Always answer in metric units.' } });
  const id = await send(null, 'first');
  assert.ok(!system().includes('metric units'), 'not in a folder yet');

  await call(`/api/chats/${id}/organize`, { method: 'POST', body: { folder: 'Recipes' } });
  await send(id, 'second');
  assert.match(system(), /BASE PROMPT[\s\S]*folder "Recipes"[\s\S]*Always answer in metric units\./, 'after the system prompt');

  // An edit counts from the next turn on.
  await call('/api/folders', { method: 'PATCH', body: { name: 'Recipes', prompt: 'Use grams.' } });
  await send(id, 'third');
  assert.ok(system().includes('Use grams.') && !system().includes('metric units'));

  await send(null, 'elsewhere');
  assert.ok(!system().includes('Use grams.'), 'another chat does not get it');

  await call(`/api/chats/${id}/organize`, { method: 'POST', body: { folder: null } });
  await send(id, 'fourth');
  assert.ok(!system().includes('Use grams.'), 'moved out, it stops');
});
