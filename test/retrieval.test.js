// Issue #3: lexical / dense / hybrid retrieval for read_document. Offline and
// deterministic: a tiny concept-vector "model" stands in for ONNX here; the
// same code path runs the real bundle (see the gated test at the bottom).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Store, ALL_USERS } from '../src/store.js';
import { Retrieval, fuse } from '../src/retrieval.js';
import { callReadDocument } from '../src/document_tool.js';
import { loadEmbedder, PRESETS } from '../src/embedding.js';
import { configProblems, DEFAULTS } from '../src/config.js';

// Words map to concepts, so "car" and "automobile" land together -- the
// thing BM25 cannot do and embeddings can.
const CONCEPTS = [
  ['car', 'automobile', 'vehicle', 'sedan'],
  ['money', 'revenue', 'income', 'profit', 'earnings'],
  ['doctor', 'physician', 'clinic', 'patient'],
  ['cat', 'kitten', 'feline'],
];
function fakeEmbedder(key = 'fake:v1') {
  const calls = [];
  return {
    key, dim: CONCEPTS.length, calls,
    async embed(texts) {
      calls.push(texts.length);
      return texts.map((t) => {
        const words = t.toLowerCase().match(/[a-z]+/g) || [];
        const v = new Float32Array(CONCEPTS.length);
        CONCEPTS.forEach((group, i) => { for (const w of words) if (group.includes(w)) v[i] += 1; });
        return v;
      });
    }
  };
}

const PARAS = [
  'The sedan needs new tyres before winter.',
  'Quarterly earnings beat the forecast by a wide margin.',
  'The physician moved her clinic to the old library.',
  'Our kitten sleeps all afternoon.',
];
function setup(mode = 'hybrid', embedder = fakeEmbedder()) {
  const store = new Store(':memory:');
  const chat = store.createChat({}, ALL_USERS);
  // Each topic fills about one 1,800-char chunk, like a real document section.
  const content = PARAS.map((p) => `${p} `.repeat(Math.floor(1500 / (p.length + 1))).trim()).join('\n\n');
  const doc = store.addDocument(chat.id, { filename: 'notes.txt', content });
  const r = new Retrieval(store, { ...DEFAULTS.retrieval, mode }, mode === 'lexical' ? null : embedder);
  return { store, chat, doc, r, embedder };
}

test('RRF fusion follows TinySearch: ranks, weights, k=60, deterministic ties', () => {
  // bm25 ranks 0,1,2; dense ranks 2,1,0. Chunks 0 and 2 each get one first
  // place: 1/61 + 1/63 beats chunk 1's two second places (2/62), and their
  // exact tie breaks on the dense score.
  const rows = fuse([3, 2, 0], [0.1, 0.8, 0.9], { denseWeight: 0.5, k: 60 });
  const rrf = (b, d) => 0.5 / (60 + b) + 0.5 / (60 + d);
  assert.deepEqual(rows.map((r) => r.index), [2, 0, 1]);
  assert.equal(rows[0].rrf, rrf(3, 1));
  assert.equal(rows[2].rrf, rrf(2, 2));
  // Weights shift it: mostly-dense puts chunk 2 clearly first, mostly-BM25 chunk 0.
  assert.equal(fuse([3, 2, 0], [0.1, 0.8, 0.9], { denseWeight: 0.9 })[0].index, 2);
  assert.equal(fuse([3, 2, 0], [0.1, 0.8, 0.9], { denseWeight: 0.1 })[0].index, 0);
  // A side with no signal (all BM25 zero) stays neutral: dense decides alone.
  assert.deepEqual(fuse([0, 0, 0], [0.1, 0.9, 0.5]).map((r) => r.index), [1, 2, 0]);
  // Exact ties fall back to dense score, then bm25, then document order.
  assert.deepEqual(fuse([0, 0, 0], [0, 0, 0]).map((r) => r.index), [0, 1, 2]);
  // Same inputs, same output, every time.
  assert.deepEqual(fuse([1, 5, 2, 5], [0.3, 0.3, 0.9, 0.1]), fuse([1, 5, 2, 5], [0.3, 0.3, 0.9, 0.1]));
});

test('lexical mode is exactly the old FTS5 behaviour', async () => {
  const { store, doc, r } = setup('lexical');
  assert.deepEqual(await r.search(doc.id, 'kitten', 5), store.searchPassages(doc.id, 'kitten', 5));
  assert.deepEqual(await r.search(doc.id, 'automobile', 5), [], 'no shared words, no match');
});

test('hybrid finds what BM25 alone misses, and keeps exact matches on top', async () => {
  const { store, doc, r } = setup('hybrid');
  assert.deepEqual(store.searchPassages(doc.id, 'automobile', 5), []);
  const hits = await r.search(doc.id, 'automobile', 2);
  assert.match(hits[0].body, /sedan/);
  const exact = await r.search(doc.id, 'kitten sleeps', 1);
  assert.match(exact[0].body, /kitten/);
  // Same query, same ranking.
  assert.deepEqual(await r.search(doc.id, 'income', 4), await r.search(doc.id, 'income', 4));
  assert.match((await r.search(doc.id, 'income', 1))[0].body, /earnings/);
});

test('dense mode ranks by embeddings alone', async () => {
  const { doc, r } = setup('dense');
  assert.match((await r.search(doc.id, 'patient', 1))[0].body, /physician/);
});

test('embeddings are stored in SQLite once and reused by every query', async () => {
  const { store, doc, r, embedder } = setup('hybrid');
  assert.equal(await r.ingest(doc.id), store.documentPassages(doc.id).length);
  const stored = store.chunkVectors(doc.id, embedder.key);
  assert.equal(stored.size, store.documentPassages(doc.id).length);
  assert.ok([...stored.values()].every((vs) => vs.length >= 1 && vs[0] instanceof Float32Array));
  embedder.calls.length = 0;
  assert.equal(await r.ingest(doc.id), 0, 'ingesting again embeds nothing');
  await r.search(doc.id, 'car', 3);
  await r.search(doc.id, 'money', 3);
  assert.deepEqual(embedder.calls, [1, 1], 'queries embed only the query text');
});

test('a model change re-embeds and drops the old vectors; deletes clean up', async () => {
  const { store, chat, doc, r } = setup('hybrid', fakeEmbedder('fake:v1'));
  await r.ingest(doc.id);
  const r2 = new Retrieval(store, { ...DEFAULTS.retrieval, mode: 'hybrid' }, fakeEmbedder('fake:v2'));
  assert.deepEqual(store.documentsMissingVectors('fake:v2'), [doc.id]);
  await r2.backfill();
  assert.equal(store.chunkVectors(doc.id, 'fake:v1').size, 0);
  assert.ok(store.chunkVectors(doc.id, 'fake:v2').size > 0);
  store.deleteChat(chat.id, ALL_USERS);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM document_chunks').get().n, 0);
});

test('read_document keeps its interface in every mode', async () => {
  for (const mode of ['lexical', 'hybrid']) {
    const { store, chat, doc, r } = setup(mode);
    const out = await callReadDocument({ document_id: doc.id, query: 'kitten' }, { store, retrieval: r, chatId: chat.id });
    assert.match(out, /passage\(s\) matching "kitten"/, mode);
    assert.match(out, /--- passage \d+ \(offset/, mode);
  }
});

test('no bundle means a clear startup error, never a download', async () => {
  await assert.rejects(loadEmbedder({ model: 'fast' }, '/nonexistent/models'), /tinywebui models pull fast.*never downloads/);
  await assert.rejects(loadEmbedder({ model: 'mystery' }, '/x'), /not a preset/);
});

test('retrieval settings are validated', () => {
  const bad = configProblems({ ...DEFAULTS, retrieval: { mode: 'vector', denseWeight: 1, rrfK: -1, modelSha256: 'abc', colour: 1 } }).join('\n');
  for (const needle of ['retrieval.mode', 'retrieval.denseWeight', 'retrieval.rrfK', 'retrieval.modelSha256', 'retrieval.colour']) assert.ok(bad.includes(needle), needle);
  assert.deepEqual(configProblems({ ...DEFAULTS, retrieval: { ...DEFAULTS.retrieval, mode: 'hybrid' } }), []);
});

// Real model, when one is on disk: TINYWEBUI_TEST_MODELS_DIR=<dir holding
// all-minilm-l6-v2-onnx> with onnxruntime-node and @huggingface/tokenizers
// installed. Skipped otherwise, so the default suite stays offline.
const realDir = process.env.TINYWEBUI_TEST_MODELS_DIR;
test('real MiniLM bundle: hybrid retrieval quality', { skip: !realDir && 'set TINYWEBUI_TEST_MODELS_DIR' }, async () => {
  const embedder = await loadEmbedder({ model: 'fast' }, realDir);
  const { doc, r } = setup('hybrid', embedder);
  const expect = { 'automobile maintenance': /sedan/, 'company profit': /earnings/, 'seeing a medical professional': /physician/, 'young cat': /kitten/ };
  for (const [q, re] of Object.entries(expect)) assert.match((await r.search(doc.id, q, 1))[0].body, re, q);
  embedder.close();
});

// Same, for the multilingual bundle (granite-embedding-107m-multilingual-onnx
// in TINYWEBUI_TEST_MODELS_DIR): English questions find German passages,
// which share no words for BM25 to match.
const multiDir = realDir && existsSync(join(realDir, PRESETS.multilingual.localDir));
test('real multilingual bundle: English questions find German passages', { skip: !multiDir && 'pull multilingual into TINYWEBUI_TEST_MODELS_DIR' }, async () => {
  const embedder = await loadEmbedder({ model: 'multilingual' }, realDir);
  assert.equal(embedder.dim, 384);
  const store = new Store(':memory:');
  const chat = store.createChat({}, ALL_USERS);
  const german = [
    'Die Limousine braucht vor dem Winter neue Reifen.',
    'Der Quartalsgewinn hat die Prognose deutlich übertroffen.',
    'Die Ärztin hat ihre Praxis in die alte Bibliothek verlegt.',
    'Unser Kätzchen schläft den ganzen Nachmittag.',
  ];
  const content = german.map((p) => `${p} `.repeat(Math.floor(1500 / (p.length + 1))).trim()).join('\n\n');
  const doc = store.addDocument(chat.id, { filename: 'notizen.txt', content });
  const r = new Retrieval(store, { ...DEFAULTS.retrieval, mode: 'dense' }, embedder);
  const expect = { 'car tyres': /Limousine/, 'company profit': /Quartalsgewinn/, 'seeing a doctor': /Ärztin/, 'young cat': /Kätzchen/ };
  for (const [q, re] of Object.entries(expect)) assert.match((await r.search(doc.id, q, 1))[0].body, re, q);
  embedder.close();
});

test('passages follow retrieval.passageSize; changing it re-splits stored documents', async () => {
  const store = new Store(':memory:');
  const chat = store.createChat({}, ALL_USERS);
  const text = 'word '.repeat(2000).trim();                       // ~10,000 chars
  const doc = store.addDocument(chat.id, { filename: 'a', content: text });
  const before = store.documentPassages(doc.id).length;
  assert.ok(before >= 5, 'default 1800-char passages');

  const big = new Retrieval(store, { ...DEFAULTS.retrieval, passageSize: 4000, passageOverlap: 400 }, null);
  await big.backfill();
  const after = store.documentPassages(doc.id);
  assert.ok(after.length < before, 'bigger passages, fewer of them');
  assert.ok(after.every((p) => p.body.length <= 4000));
  assert.equal(store.documentsWithOtherPassages(4000, 400).length, 0, 're-split once, recorded on the document');
  // New uploads use the configured split directly.
  const d2 = store.addDocument(chat.id, { filename: 'b', content: text }, big.passageSettings());
  assert.equal(store.documentPassages(d2.id).length, after.length);
  // Lexical search still works on the new passages.
  assert.ok(store.searchPassages(doc.id, 'word', 1).length === 1);
});

test('re-splitting drops the old passages\' vectors and re-embeds', async () => {
  const embedder = fakeEmbedder('fake:v1');
  const { store, doc, r } = setup('hybrid', embedder);
  await r.ingest(doc.id);
  const r2 = new Retrieval(store, { ...DEFAULTS.retrieval, mode: 'hybrid', passageSize: 900, passageOverlap: 100 }, embedder);
  await r2.backfill();
  const passages = store.documentPassages(doc.id);
  const vectors = store.chunkVectors(doc.id, embedder.key);
  assert.equal(vectors.size, passages.length, 'every new passage has vectors, no orphans');
  assert.ok(passages.every((p) => vectors.has(p.rowid)));
});

test('an existing database migrates to passages/chunks in place', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const dir = mkdtempSync(join(tmpdir(), 'tinywebui-passages-'));
  const file = join(dir, 'old.db');
  // Build a schema-2 style database with the old table names and one document.
  const s = new Store(file);
  const chat = s.createChat({}, ALL_USERS);
  const doc = s.addDocument(chat.id, { filename: 'a', content: 'alpha beta gamma' });
  s.close();
  const db = new DatabaseSync(file);
  db.exec('DROP TABLE document_chunks');
  db.exec('ALTER TABLE document_passages RENAME TO document_chunks');
  db.exec('ALTER TABLE document_passage_map RENAME TO document_chunk_map');
  db.exec('ALTER TABLE document_chunk_map RENAME COLUMN passage_rowid TO chunk_rowid');
  db.exec('ALTER TABLE document_chunk_map RENAME COLUMN passage_idx TO chunk_idx');
  db.exec('PRAGMA user_version = 2');
  db.close();

  const migrated = new Store(file);
  assert.equal(migrated.migratedFrom, 2);
  assert.equal(migrated.searchPassages(doc.id, 'beta', 1)[0].body, 'alpha beta gamma');
  const tables = migrated.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'document_%'").all().map((t) => t.name);
  assert.ok(tables.includes('document_passage_map') && !tables.includes('document_chunk_map'));
  migrated.close();
  rmSync(dir, { recursive: true, force: true });
});

test('passage and chunk settings are validated', () => {
  const bad = configProblems({ ...DEFAULTS, retrieval: { ...DEFAULTS.retrieval, passageSize: 50, passageOverlap: 5000, chunkOverlap: 999 } }).join('\n');
  for (const needle of ['retrieval.passageSize', 'retrieval.passageOverlap', 'retrieval.chunkOverlap']) assert.ok(bad.includes(needle), needle);
});
