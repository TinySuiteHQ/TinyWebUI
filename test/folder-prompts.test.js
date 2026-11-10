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
const send = async (chatId, message, extra = {}) => {
  const res = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chatId, message, ...extra }) });
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

test('a chat started in a folder is filed there before its first turn, which already follows the folder', async () => {
  await call('/api/folders', { method: 'POST', body: { name: 'Workshop', prompt: 'Speak like a carpenter.' } });
  const id = await send(null, 'hi there', { folder: 'Workshop' });
  assert.match(system(), /folder "Workshop"[\s\S]*Speak like a carpenter\./, 'the very first turn has the instructions');
  assert.equal((await call('/api/chats')).data.chats.find((c) => c.id === id).folder, 'Workshop');

  // Only a first message files a chat, and only into a folder that exists: moving is the folder's job.
  const loose = await send(null, 'not in one');
  await send(loose, 'again', { folder: 'Workshop' });
  assert.equal((await call('/api/chats')).data.chats.find((c) => c.id === loose).folder ?? null, null);
  const stray = await send(null, 'where to', { folder: 'No such folder' });
  assert.equal((await call('/api/chats')).data.chats.find((c) => c.id === stray).folder ?? null, null);
});

test("a folder's chats are set from the folder in one go: listed ones join, the rest leave, and the order stays", async () => {
  await call('/api/folders', { method: 'POST', body: { name: 'Picked' } });
  await call('/api/folders', { method: 'POST', body: { name: 'Elsewhere' } });
  const a = await send(null, 'chat a');
  const b = await send(null, 'chat b');
  const c = await send(null, 'chat c');
  await call(`/api/chats/${c}/organize`, { method: 'POST', body: { folder: 'Elsewhere' } });
  const order = (await call('/api/chats')).data.chats.map((x) => x.id);
  const folderOf = async (id) => (await call('/api/chats')).data.chats.find((x) => x.id === id).folder;

  assert.equal((await call('/api/folders/chats', { method: 'PATCH', body: { name: 'Picked', chatIds: [a, c] } })).status, 200);
  assert.equal(await folderOf(a), 'Picked');
  assert.equal(await folderOf(c), 'Picked', 'taken from the folder it was in');
  assert.equal(await folderOf(b), null);
  assert.deepEqual((await call('/api/chats')).data.chats.map((x) => x.id), order, 'moving is not activity');

  await call('/api/folders/chats', { method: 'PATCH', body: { name: 'Picked', chatIds: [b] } });
  assert.equal(await folderOf(b), 'Picked');
  assert.equal(await folderOf(a), null, 'unticked: no folder');
  assert.equal(await folderOf(c), null);

  assert.equal((await call('/api/folders/chats', { method: 'PATCH', body: { name: 'Nope', chatIds: [a] } })).status, 404);
  assert.equal((await call('/api/folders/chats', { method: 'PATCH', body: { name: 'Picked', chatIds: 'all' } })).status, 400);
});

test('a deleted folder lets its chats go to no folder, or takes them with it when asked', async () => {
  await call('/api/folders', { method: 'POST', body: { name: 'Keepers', prompt: 'Be brief.' } });
  const kept = await send(null, 'keep me', { folder: 'Keepers' });
  const out = await call('/api/folders/delete', { method: 'POST', body: { name: 'Keepers' } });
  assert.equal(out.status, 200);
  assert.deepEqual(out.data, { folder: 'Keepers', chats: 1, chatsDeleted: false });
  const after = (await call('/api/folders')).data;
  assert.ok(!after.folders.includes('Keepers') && !('Keepers' in after.prompts), 'the folder and its instructions are gone');
  assert.equal((await call('/api/chats')).data.chats.find((c) => c.id === kept).folder ?? null, null, 'its chat stays, in no folder');

  await call('/api/folders', { method: 'POST', body: { name: 'Goners' } });
  const gone = await send(null, 'delete me', { folder: 'Goners' });
  const bystander = await send(null, 'not in it');
  assert.equal((await call('/api/folders/delete', { method: 'POST', body: { name: 'Goners', deleteChats: true } })).data.chats, 1);
  const ids = (await call('/api/chats')).data.chats.map((c) => c.id);
  assert.ok(!ids.includes(gone) && ids.includes(bystander), 'only the chats in it went');
  assert.equal((await call(`/api/chats/${gone}`)).status, 404);

  assert.equal((await call('/api/folders/delete', { method: 'POST', body: { name: 'Goners' } })).status, 404);
  assert.equal((await call('/api/folders/delete', { method: 'POST', body: { name: 'x', deleteChats: 'yes' } })).status, 400);
});

test('a chat is renamed in place, without moving up the list', async () => {
  const a = await send(null, 'first of two');
  await send(null, 'second of two');
  const order = (await call('/api/chats')).data.chats.map((x) => x.id);
  const renamed = await call(`/api/chats/${a}`, { method: 'PATCH', body: { title: '  My   chat  ' } });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.data.title, 'My chat');
  const list = (await call('/api/chats')).data.chats;
  assert.equal(list.find((x) => x.id === a).title, 'My chat');
  assert.deepEqual(list.map((x) => x.id), order);
  assert.equal((await call(`/api/chats/${a}`, { method: 'PATCH', body: { title: '   ' } })).status, 400);
  assert.equal((await call('/api/chats/nope', { method: 'PATCH', body: { title: 'x' } })).status, 404);
});
