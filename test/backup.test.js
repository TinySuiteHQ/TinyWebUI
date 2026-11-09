// Export and import: a chat as Markdown or a backup file, everything of a
// person's as one backup, and that backup back in, for them or for someone
// else, without overwriting anything and without bringing files along.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { trustedServer } from './trusted-helpers.js';

const t = await trustedServer({
  access: {
    customize: ['theme', 'instructions'],
    roles: { user: { features: ['chat', 'folders', 'automations'], models: '*' } }
  }
});
test.after(() => t.srv.shutdown());

const alice = t.as({ id: 'sub-alice' });
const bob = t.as({ id: 'sub-bob' });
const carol = t.as({ id: 'sub-carol' });
const NOTE = '\n\n[Attached document: "report.pdf" (id: doc-1, 1,234 chars). Use read_document to search or read it.]';

/** Alice's chats, written straight to the store: one with a tool round, a file and a task, and a fork of it. */
async function seedAlice() {
  const userId = (await alice('/api/auth/me')).data.user.id;
  await alice('/api/me/prefs', { method: 'POST', body: { instructions: 'Be brief.' } });
  const { Store } = await import('../server/store/index.ts');
  const store = new Store(join(t.dir, 'chats.db'));
  try {
    store.chats.create({ id: 'c-tools', title: 'Quarterly report' }, userId);
    store.chats.createFolder('Work', userId);
    store.chats.updateFolder('Work', { prompt: 'Use metric units.' }, userId);
    store.chats.organize('c-tools', { folder: 'Work' }, userId);
    store.messages.add('c-tools', { role: 'user', content: `Summarise this${NOTE}`, images: [{ mime: 'image/png', data: 'AAAA' }] });
    store.messages.add('c-tools', { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'search', arguments: '{"q":"revenue"}' } }] });
    const artifact = store.messages.addArtifact('c-tools', { toolName: 'search', args: { q: 'revenue' }, content: 'Revenue rose 12%.' });
    store.messages.add('c-tools', { role: 'tool', tool_call_id: 'call-1', content: 'Revenue rose 12%.', artifact_id: artifact });
    store.messages.add('c-tools', { role: 'assistant', content: 'Revenue rose 12% this quarter.', model: 'm', usage: { prompt_tokens: 50, completion_tokens: 8 } });
    store.chats.addTask('c-tools', 'Check the figures');
    store.chats.create({ id: 'c-fork', title: 'Quarterly report (fork)' }, userId);
    store.messages.add('c-fork', { role: 'user', content: 'Summarise this' });
    store.automations.create({ chatId: 'c-tools', name: 'Weekly', prompt: 'Summarise the week', cron: '0 9 * * 1', timezone: 'UTC', nextRunAt: Date.now() + 1e6 }, userId);
  } finally { store.close(); }
  // A fork's link to its original is set by fork(), not create(); written here the way fork() leaves it.
  const store2 = new Store(join(t.dir, 'chats.db'));
  try { store2.db.prepare("UPDATE chats SET parent_id = 'c-tools', fork_seq = 0 WHERE id = 'c-fork'").run(); } finally { store2.close(); }
}
await seedAlice();
const backup = (await alice('/api/export')).data;

test('a full export carries chats, tool output, folders, automations and preferences, but no files', () => {
  assert.equal(backup.format, 'tinywebui-backup');
  assert.equal(backup.version, 1);
  assert.deepEqual(backup.chats.map((c) => c.id).sort(), ['c-fork', 'c-tools']);
  const chat = backup.chats.find((c) => c.id === 'c-tools');
  assert.equal(chat.folder, 'Work');
  const [question, call, result, answer] = chat.messages;
  assert.equal(question.content, 'Summarise this', 'the note pointing at the file goes with the file');
  assert.deepEqual(question.attachments, ['report.pdf']);
  assert.equal(question.images, 1);
  assert.ok(!JSON.stringify(backup).includes('AAAA'), 'image bytes are not in the file');
  assert.equal(call.toolCalls[0].function.name, 'search');
  assert.equal(result.artifact.content, 'Revenue rose 12%.');
  assert.deepEqual(answer.usage, { prompt_tokens: 50, completion_tokens: 8 });
  assert.equal(chat.tasks[0].title, 'Check the figures');
  assert.deepEqual(backup.folders, [{ name: 'Work', prompt: 'Use metric units.' }]);
  assert.equal(backup.automations[0].name, 'Weekly');
  assert.equal(backup.preferences.instructions, 'Be brief.');
});

test('one chat exports as a backup file or as a readable Markdown transcript', async () => {
  const one = (await alice('/api/chats/c-tools/export')).data;
  assert.deepEqual(one.chats.map((c) => c.id), ['c-tools']);
  assert.equal(one.automations, undefined, 'a single chat carries only itself');
  const res = await fetch(`${t.base}/api/chats/c-tools/export?format=md`, { headers: { 'x-tinysuite-user-id': 'sub-alice' } });
  assert.match(res.headers.get('content-disposition'), /attachment; filename="quarterly-report\.md"/);
  const md = await res.text();
  assert.match(md, /^# Quarterly report/);
  assert.match(md, /## You · /);
  assert.match(md, /\*Attached: report\.pdf, 1 image\*/);
  assert.match(md, /## Assistant \(m\)\n\n\*Used `search`\*\n\nRevenue rose 12% this quarter\./);
  assert.ok(!md.includes('read_document'));
  assert.equal((await bob('/api/chats/c-tools/export')).status, 404, 'only the owner exports a chat');
});

test('someone else importing it gets their own copies, with the fork under its original and automations paused', async () => {
  const r = await bob('/api/import', { method: 'POST', body: backup });
  assert.equal(r.status, 200);
  assert.equal(r.data.chats, 2);
  assert.equal(r.data.skipped, 0);
  assert.equal(r.data.folders, 1);
  assert.equal(r.data.automations, 1);
  assert.equal(r.data.instructions, 'set');
  const chats = (await bob('/api/chats')).data.chats;
  const copy = chats.find((c) => c.title === 'Quarterly report');
  const fork = chats.find((c) => c.title === 'Quarterly report (fork)');
  assert.notEqual(copy.id, 'c-tools', 'the id is Alice\'s, so Bob\'s copy gets a new one');
  assert.equal(fork.parent_id, copy.id);
  assert.equal(copy.folder, 'Work');
  const full = (await bob(`/api/chats/${copy.id}`)).data;
  assert.deepEqual(full.messages.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(full.messages[0].content, 'Summarise this');
  assert.equal(full.tasks[0].title, 'Check the figures');
  const auto = (await bob('/api/automations')).data.automations[0];
  assert.equal(auto.enabled, false);
  assert.equal(auto.chatId, copy.id);
  assert.equal((await bob('/api/auth/me')).data.instructions, 'Be brief.');
  assert.equal((await alice('/api/chats')).data.chats.length, 2, 'Alice\'s own chats are untouched');
});

test('importing the same file again changes nothing', async () => {
  const again = await alice('/api/import', { method: 'POST', body: backup });
  assert.deepEqual([again.data.chats, again.data.skipped, again.data.automations], [0, 2, 0]);
  assert.equal((await alice('/api/chats')).data.chats.length, 2);
  assert.equal((await alice('/api/automations')).data.automations.length, 1);
});

test('instructions already set are kept, not overwritten', async () => {
  await carol('/api/me/prefs', { method: 'POST', body: { instructions: 'Be thorough.' } });
  const r = await carol('/api/import', { method: 'POST', body: backup });
  assert.equal(r.data.instructions, 'kept');
  assert.equal((await carol('/api/auth/me')).data.instructions, 'Be thorough.');
});

test('a file that is not a valid backup is refused whole, writing nothing', async () => {
  assert.equal((await bob('/api/import', { method: 'POST', body: { hello: 1 } })).status, 400);
  const newer = await bob('/api/import', { method: 'POST', body: { ...backup, version: 99 } });
  assert.equal(newer.status, 400);
  assert.match(newer.data.error, /newer/);
  const before = (await bob('/api/chats')).data.chats.length;
  const broken = structuredClone(backup);
  broken.chats[0].id = 'fresh-1';
  broken.chats[1].id = 'fresh-2';
  broken.chats[1].messages = [{ seq: 3, role: 'user', content: 'a' }, { seq: 1, role: 'assistant', content: 'b' }];
  const r = await bob('/api/import', { method: 'POST', body: broken });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /out of order/);
  assert.equal((await bob('/api/chats')).data.chats.length, before, 'the valid chat before it was not written either');
});

test('tool calls the provider could not be sent back are refused; usage is cleaned, its attribution kept', async () => {
  const bad = structuredClone(backup);
  bad.chats = [bad.chats.find((c) => c.id === 'c-tools')];
  bad.chats[0].id = 'shape-1';
  bad.chats[0].messages[1].toolCalls = [{ oops: true }];
  const refused = await bob('/api/import', { method: 'POST', body: bad });
  assert.equal(refused.status, 400);
  assert.match(refused.data.error, /toolCalls/);

  const odd = structuredClone(backup);
  odd.chats = [odd.chats.find((c) => c.id === 'c-tools')];
  odd.chats[0].id = 'shape-2';
  odd.chats[0].title = 'Odd usage';
  odd.automations = [];
  const attribution = { version: 1, estimator: 'chars/4', cached: null,
    input: { total: 50, source: 'provider', buckets: [{ category: 'operator', source: 'estimated', tokens: 40 }, { category: 'bad', tokens: 'x' }] },
    output: { total: 8, source: 'provider', buckets: [] } };
  odd.chats[0].messages[3].usage = { prompt_tokens: 50, completion_tokens: 'eight', note: { deep: { deeper: 1 } }, attribution };
  const r = await carol('/api/import', { method: 'POST', body: odd });
  assert.equal(r.status, 200);
  const id = (await carol('/api/chats')).data.chats.find((c) => c.title === 'Odd usage').id;
  const usage = (await carol(`/api/chats/${id}`)).data.messages[3].usage;
  assert.equal(usage.prompt_tokens, 50);
  assert.equal(usage.completion_tokens, undefined, 'not a number, so not kept');
  assert.deepEqual(usage.attribution.input.buckets, [{ category: 'operator', source: 'estimated', tokens: 40 }]);
});
