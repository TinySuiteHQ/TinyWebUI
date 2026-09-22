import test from 'node:test';
import assert from 'node:assert/strict';

import { digest, planEpoch, applyEpoch, estimateTokens, textMap } from '../src/compact.js';
import { Store, toWire, toView } from '../src/store.js';
import { callExpand } from '../src/context_tool.js';

const big = (n, fill = 'x') => fill.repeat(n);

function artifact(content, over = {}) {
  return { id: 'aabbccdd', tool_name: 'srv__thing', content, char_len: content.length, ...over };
}

/* ---------- the digest is deterministic, which is what freezes the prefix ---------- */

test('digest is byte-identical for identical input', () => {
  const a = artifact(big(5000));
  assert.equal(digest(a), digest(a));
  assert.equal(digest(a), digest(artifact(big(5000))));
});

test('digest shrinks large output and keeps both ends verbatim', () => {
  const content = 'HEAD-MARKER' + big(5000) + 'TAIL-MARKER';
  const out = digest(artifact(content));
  assert.ok(out.length < content.length);
  assert.ok(out.startsWith('[compacted: artifact aabbccdd'));
  assert.ok(out.includes('HEAD-MARKER'));
  assert.ok(out.includes('TAIL-MARKER'));
  assert.ok(out.includes('context_expand("aabbccdd"'));
});

test('digest leaves small output alone rather than growing it', () => {
  const content = 'short result';
  assert.equal(digest(artifact(content)), content);
});

/* ---------- tool-agnostic: only generic structure is inferred ---------- */

test('outline handles json, xml-ish and prose without knowing any tool', () => {
  const json = digest(artifact(JSON.stringify({ alpha: 1, beta: big(5000) })));
  assert.ok(json.includes('json object, keys: alpha, beta'), json.slice(0, 200));

  const xml = digest(artifact('<result><item>a</item><item>b</item></result>' + big(5000)));
  assert.match(xml, /tags: item×2|tags: .*item/);

  const prose = digest(artifact(big(5000).replace(/x/g, 'a') + '\nline two'));
  assert.ok(prose.includes('plain text,'));
});

test('malformed json falls through to another shape rather than throwing', () => {
  const out = digest(artifact('{not really json' + big(5000)));
  assert.ok(out.includes('[compacted: artifact'));
});

/* ---------- epoch planning ---------- */

const rows = (specs) => specs.map((s, i) => ({ id: i + 1, seq: i, ...s }));

const convo = rows([
  { role: 'user', content: 'q1' },
  { role: 'assistant', content: null, tool_calls_json: '[]' },
  { role: 'tool', content: big(9000), artifact_id: 'a1', stub_text: null },
  { role: 'assistant', content: 'answer 1' },
  { role: 'user', content: 'q2' },
  { role: 'tool', content: big(9000), artifact_id: 'a2', stub_text: null },
  { role: 'assistant', content: 'answer 2' },
  { role: 'user', content: 'q3' }
]);

test('no epoch below the threshold', () => {
  assert.equal(planEpoch(convo, { threshold: 60000, keepTurns: 2, promptTokens: 100 }), null);
});

test('epoch demotes only tool results older than the kept turns', () => {
  const plan = planEpoch(convo, { threshold: 1000, keepTurns: 2, promptTokens: 5000 });
  assert.ok(plan);
  assert.equal(plan.boundarySeq, 4); // the "q2" user message
  assert.deepEqual(plan.targets.map((r) => r.artifact_id), ['a1']);
});

test('epoch is null when there is nothing left to demote', () => {
  const already = convo.map((r) => (r.artifact_id ? { ...r, stub_text: 'stub' } : r));
  assert.equal(planEpoch(already, { threshold: 1000, keepTurns: 2, promptTokens: 5000 }), null);
});

test('epoch is null when the conversation is shorter than the kept turns', () => {
  const short = rows([{ role: 'user', content: 'q' }, { role: 'tool', content: big(9000), artifact_id: 'a' }]);
  assert.equal(planEpoch(short, { threshold: 1000, keepTurns: 2, promptTokens: 5000 }), null);
});

test('estimateTokens counts content and tool calls', () => {
  assert.equal(estimateTokens([{ role: 'user', content: 'abcd' }]), 1);
  assert.equal(estimateTokens([{ role: 'assistant', content: null }]), 0);
});

/* ---------- store + apply, end to end ---------- */

function seeded() {
  const store = new Store(':memory:');
  const chat = store.createChat({ title: 't' });
  const mk = (toolText) => {
    const id = store.addArtifact(chat.id, { toolName: 'srv__thing', args: { q: 1 }, content: toolText });
    store.addMessage(chat.id, { role: 'tool', tool_call_id: 'tc', content: toolText, artifact_id: id });
    return id;
  };
  store.addMessage(chat.id, { role: 'user', content: 'q1' });
  const a1 = mk(big(9000));
  store.addMessage(chat.id, { role: 'assistant', content: 'answer 1', usage: { prompt_tokens: 90000 } });
  store.addMessage(chat.id, { role: 'user', content: 'q2' });
  mk(big(9000));
  store.addMessage(chat.id, { role: 'assistant', content: 'answer 2' });
  store.addMessage(chat.id, { role: 'user', content: 'q3' });
  return { store, chat, a1 };
}

test('applyEpoch shrinks the wire but leaves the transcript whole', () => {
  const { store, chat } = seeded();
  const before = store.messages(chat.id);
  const plan = planEpoch(before, { threshold: 1000, keepTurns: 2, promptTokens: 90000 });
  const done = applyEpoch(store, chat, plan);
  assert.ok(done.saved > 8000);
  assert.equal(done.epoch, 1);

  const after = store.messages(chat.id);
  const demoted = after.find((r) => r.stub_text);
  assert.equal(demoted.content.length, 9000, 'transcript keeps the full text');
  assert.ok(toWire(demoted).content.length < 1500, 'the wire gets the stub');
  assert.equal(toView(demoted).content.length, 9000);
  assert.equal(toView(demoted).compacted, true);
});

test('a second epoch over the same state is a no-op', () => {
  const { store, chat } = seeded();
  const first = planEpoch(store.messages(chat.id), { threshold: 1000, keepTurns: 2, promptTokens: 90000 });
  applyEpoch(store, chat, first);
  const again = planEpoch(store.messages(chat.id), { threshold: 1000, keepTurns: 2, promptTokens: 90000 });
  assert.equal(again, null, 'idempotent: nothing left to demote');
});

test('the frozen prefix rebuilds byte-identically', () => {
  const { store, chat } = seeded();
  const plan = planEpoch(store.messages(chat.id), { threshold: 1000, keepTurns: 2, promptTokens: 90000 });
  applyEpoch(store, chat, plan);
  const once = JSON.stringify(store.messages(chat.id).map(toWire));
  const twice = JSON.stringify(store.messages(chat.id).map(toWire));
  assert.equal(once, twice);
});

test('usage survives a round trip through the store', () => {
  const { store, chat } = seeded();
  const withUsage = store.messages(chat.id).map(toView).filter((m) => m.usage);
  assert.equal(withUsage.length, 1);
  assert.equal(withUsage[0].usage.prompt_tokens, 90000);
});

/* ---------- context_expand ---------- */

test('context_expand greps, windows and refuses cross-chat reads', () => {
  const { store, chat, a1 } = seeded();
  const store2 = store;
  const other = store2.createChat({ title: 'other' });

  const text = 'alpha line\nbeta line\nNEEDLE here\ngamma line\n' + big(3000);
  const id = store.addArtifact(chat.id, { toolName: 'srv__thing', args: {}, content: text });

  const hit = callExpand({ artifact_id: id, grep: 'needle' }, { store, chatId: chat.id, budget: 4000 });
  assert.ok(hit.includes('NEEDLE here'));
  assert.ok(hit.includes('beta line'), 'context lines included');

  const miss = callExpand({ artifact_id: id, grep: 'zzzz' }, { store, chatId: chat.id, budget: 4000 });
  assert.ok(miss.includes('no match'));

  const bad = callExpand({ artifact_id: id, grep: '([' }, { store, chatId: chat.id, budget: 4000 });
  assert.ok(bad.startsWith('Error: invalid regular expression'));

  const win = callExpand({ artifact_id: id, offset: 0, limit: 20 }, { store, chatId: chat.id, budget: 4000 });
  assert.ok(win.includes('alpha line'));
  assert.ok(win.includes('continue with offset='));

  const foreign = callExpand({ artifact_id: a1 }, { store, chatId: other.id, budget: 4000 });
  // Query is now scoped by chat_id at the SQL level, so a foreign chat gets the
  // same "no artifact" error as a genuinely missing id -- it can't even learn
  // that the id exists.
  assert.ok(foreign.startsWith('Error: no artifact'));

  const missing = callExpand({ artifact_id: 'nope' }, { store, chatId: chat.id, budget: 4000 });
  assert.ok(missing.startsWith('Error: no artifact'));

  assert.ok(callExpand({}, { store, chatId: chat.id }).startsWith('Error: artifact_id is required'));
});

test('context_expand respects the char budget', () => {
  const store = new Store(':memory:');
  const chat = store.createChat({ title: 't' });
  const id = store.addArtifact(chat.id, { toolName: 't', args: {}, content: big(50000) });
  const out = callExpand({ artifact_id: id, limit: 999999 }, { store, chatId: chat.id, budget: 1000 });
  assert.ok(out.length < 1400, `budget honoured, got ${out.length}`);
});


/* ---------- the offset map: what turns blind paging into one aimed read ---------- */

// A scraped page in miniature: nav boilerplate around one block of real prose.
function scraped() {
  const nav = Array.from({ length: 40 }, (_, i) => `Section ${i} | Home | About`).join('\n');
  const body = 'The article itself. '.repeat(40);
  return `${nav}\n${body}\n${nav}`;
}

test('textMap reports character offsets of the long lines, in reading order', () => {
  const text = scraped();
  const map = textMap(text);
  const offsets = [...map.matchAll(/(\d+) \(/g)].map((m) => Number(m[1]));

  assert.ok(offsets.length >= 1, 'the prose block should be listed');
  assert.deepEqual(offsets, [...offsets].sort((a, b) => a - b), 'offsets read forward');
  // The whole point: the offset must actually land on the prose, not the nav.
  assert.ok(text.slice(offsets[0]).startsWith('The article itself.'));
});

test('textMap is empty when every line is short, and deterministic', () => {
  assert.equal(textMap('short\nlines\nonly'), '');
  assert.equal(textMap(scraped()), textMap(scraped()));
});

test('a prose stub carries the map; a json stub does not', () => {
  const prose = digest(artifact(scraped()));
  assert.match(prose, /Long text at offset= \d+/);

  const rows = Array.from({ length: 300 }, (_, i) => ({ i }));
  const json = digest(artifact(JSON.stringify({ items: rows })));
  assert.doesNotMatch(json, /Long text at offset=/);
});

test('a failed grep returns the map instead of a bare miss', () => {
  const store = new Store(':memory:');
  const chat = store.createChat({ title: 'c' });
  const id = store.addArtifact(chat.id, { toolName: 'srv__scrape', args: {}, content: scraped() });

  const miss = callExpand({ artifact_id: id, grep: 'nothingmatchesthis' }, { store, chatId: chat.id, budget: 4000 });
  assert.match(miss, /no match for/);
  assert.match(miss, /Long text at offset= \d+/, 'the miss still tells the model where to read');
});
