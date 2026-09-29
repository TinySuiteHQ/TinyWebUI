import { createHash } from 'node:crypto';

/**
 * Search for everything the model can look things up in: lexical (FTS5 BM25,
 * the default), dense (local embeddings), or hybrid (both, fused). One engine,
 * any number of CORPORA -- documents and past chat turns ship built in.
 *
 * A corpus is a set of searchable UNITS (a document passage, a chat turn),
 * each belonging to an OWNER (the document, the chat). It tells the engine:
 *
 *   units(owner)                  [{ id, text }] -- what to embed for an owner
 *   ownersMissing(modelKey)       owners with units not yet embedded (backfill)
 *   candidates(scope)             unit ids one search ranks
 *   lexical(scope, query, {any})  Map(unit id -> BM25, higher is better)
 *   hydrate(hits, scope)          the result rows, from [{ id, rank, dense, bm25 }]
 *   ownersOf?(scope)              owners to embed before searching (else rely on ingest/backfill)
 *   mutable?                      true when a unit's text can change under the same id
 *   maintain?(engine, log)        one-time upkeep at backfill (e.g. re-splitting)
 *
 * Small-to-big: a unit is cut into CHUNKS sized to the embedding model, every
 * chunk is embedded, a unit scores by its best chunk, and the caller gets the
 * whole unit. BM25 scores units directly.
 *
 * The fusion is TinySearch's weighted Reciprocal Rank Fusion
 * (hybrid_embed_search_service.py): each side ranks every candidate, which
 * scores
 *
 *     (1 - denseWeight) / (k + bm25Rank) + denseWeight / (k + denseRank)
 *
 * with k = 60 and denseWeight = 0.5 by default, and ties break on the dense
 * score, then the BM25 score, then candidate order -- fully deterministic.
 *
 * Vectors are computed once per unit, stored in SQLite (`embeddings`), and
 * reused by every query; only the query itself is embedded at search time.
 */

export const RETRIEVAL_MODES = ['lexical', 'dense', 'hybrid'];

const cosine = (a, b) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
};

const digestOf = (text) => createHash('sha256').update(text).digest('hex').slice(0, 32);

/**
 * 1-based competition ranks by descending score: equal scores share a rank
 * (1, 2, 2, 4). One deliberate departure from TinySearch's _rank_by_score,
 * which numbers ties in input order -- there, a query with no BM25 match
 * at all still hands the first candidate a lexical lead. Shared ranks make a
 * side that cannot tell candidates apart stay neutral.
 */
function ranksOf(scores) {
  const order = scores.map((s, i) => i).sort((a, b) => scores[b] - scores[a]);
  const ranks = new Array(scores.length);
  order.forEach((idx, r) => {
    const prev = order[r - 1];
    ranks[idx] = r > 0 && scores[prev] === scores[idx] ? ranks[prev] : r + 1;
  });
  return ranks;
}

/**
 * Weighted RRF over parallel score lists. Returns candidate indices, best
 * first, with the scores that decided them.
 */
export function fuse(bm25Scores, denseScores, { denseWeight = 0.5, k = 60 } = {}) {
  const sparseWeight = 1 - denseWeight;
  const bm25Ranks = ranksOf(bm25Scores);
  const denseRanks = ranksOf(denseScores);
  const rows = bm25Scores.map((_, i) => ({
    index: i,
    bm25: bm25Scores[i],
    dense: denseScores[i],
    rrf: (sparseWeight > 0 ? sparseWeight / (k + bm25Ranks[i]) : 0) + (denseWeight > 0 ? denseWeight / (k + denseRanks[i]) : 0)
  }));
  rows.sort((a, b) => b.rrf - a.rrf || b.dense - a.dense || b.bm25 - a.bm25 || a.index - b.index);
  return rows;
}

/** Attached documents: one unit per passage. Scope: { docId }. */
export function documentsCorpus(store) {
  return {
    units: (docId) => store.documents.passages(docId).map((p) => ({ id: p.rowid, text: p.body })),
    ownersMissing: (key) => store.documents.missingVectors(key),
    ownersOf: ({ docId }) => [docId],
    candidates: ({ docId }) => store.documents.passages(docId).map((p) => p.rowid),
    lexical: ({ docId }, query, { any }) => store.documents.lexicalScores(docId, query, { any }),
    hydrate(hits, { docId }) {
      const byId = new Map(store.documents.passages(docId).map((p) => [p.rowid, p]));
      return hits.map((h) => {
        const p = byId.get(h.id);
        return { passageIdx: p.passageIdx, charStart: p.charStart, body: p.body, rank: h.rank, dense: h.dense, bm25: h.bm25 };
      });
    },
    maintain(engine, log) {
      const { passageSize, passageOverlap } = engine.passageSettings();
      const stale = store.documents.withOtherPassages(passageSize, passageOverlap);
      for (const id of stale) store.documents.repassage(id, passageSize, passageOverlap);
      if (stale.length) log(`re-split ${stale.length} document(s) into ${passageSize}-character passages`);
    }
  };
}

// What of a turn gets embedded: the question and the start of the answer.
const TURN_QUESTION_CHARS = 2000;
const TURN_ANSWER_CHARS = 6000;

/**
 * Past conversations: one unit per turn -- a question and the answer it
 * finally got. Scope: { userId, excludeChatId }. A turn's answer can still
 * change (the run was going when it was last embedded), so it is mutable.
 */
export function chatsCorpus(store) {
  const turnText = (t) => `${t.question.slice(0, TURN_QUESTION_CHARS)}\n\n${t.answer.slice(0, TURN_ANSWER_CHARS)}`.trim();
  return {
    mutable: true,
    units: (chatId) => store.turns.forChat(chatId).map((t) => ({ id: t.id, text: turnText(t) })).filter((u) => u.text),
    ownersMissing: (key) => store.turns.chatsMissingVectors(key),
    candidates: ({ userId, excludeChatId }) => store.turns.ids(userId, { excludeChatId }),
    lexical: ({ userId, excludeChatId }, query, { any }) => store.turns.lexicalScores(userId, query, { excludeChatId, any }),
    hydrate(hits) {
      const turns = store.turns.byIds(hits.map((h) => h.id));
      return hits.filter((h) => turns.has(h.id)).map((h) => ({ ...turns.get(h.id), rank: h.rank, dense: h.dense, bm25: h.bm25 }));
    }
  };
}

/**
 * The retrieval engine for one running instance. `embedder` is null in
 * lexical mode; otherwise it is what loadEmbedder() returned (or a stand-in
 * with the same { key, embed } shape, which is how the tests stay offline).
 * Documents and chats are registered; `register` adds more.
 */
export class Retrieval {
  constructor(store, retrieval, embedder = null) {
    this.store = store;
    this.cfg = retrieval;
    this.mode = retrieval.mode || 'lexical';
    this.embedder = this.mode === 'lexical' ? null : embedder;
    if (this.mode !== 'lexical' && !this.embedder) throw new Error(`retrieval.mode '${this.mode}' needs an embedding model`);
    this.corpora = new Map();
    this.pending = new Map(); // "corpus:owner" -> in-flight ingestion, so a query can wait for it
    this.register('documents', documentsCorpus(store));
    this.register('chats', chatsCorpus(store));
  }

  register(name, corpus) {
    this.corpora.set(name, corpus);
    return this;
  }

  #corpus(name) {
    const c = this.corpora.get(name);
    if (!c) throw new Error(`retrieval: no corpus "${name}"`);
    return c;
  }

  /**
   * Embeds whatever of one owner's units has no vectors for the current model
   * (or, for a mutable corpus, vectors of text that has since changed), and
   * drops vectors of units the owner no longer has. Idempotent: an owner that
   * is up to date costs nothing to ingest again.
   */
  ingest(name, ownerId) {
    if (!this.embedder) return Promise.resolve(0);
    const corpus = this.#corpus(name);
    const tag = `${name}:${ownerId}`;
    if (this.pending.has(tag)) return this.pending.get(tag);
    const job = (async () => {
      const key = this.embedder.key;
      const units = corpus.units(ownerId).map((u) => ({ ...u, digest: corpus.mutable ? digestOf(u.text) : '' }));
      const have = this.store.embeddings.digests(name, ownerId, key);
      if ([...have.keys()].some((id) => !units.some((u) => u.id === id))) this.store.embeddings.dropStale(name, ownerId, units.map((u) => u.id));
      const missing = units.filter((u) => have.get(u.id) !== u.digest);
      if (!missing.length) return 0;
      const prefix = this.cfg.documentPrefix || '';
      const texts = missing.map((u) => prefix + u.text);
      const vecs = this.embedder.embedPassages
        ? await this.embedder.embedPassages(texts)
        : (await this.embedder.embed(texts)).map((v) => [v]);
      // The owner may have been deleted while it was being embedded.
      const still = new Set(corpus.units(ownerId).map((u) => u.id));
      const rows = missing.map((u, i) => ({ unitId: u.id, digest: u.digest, vecs: vecs[i] })).filter((r) => still.has(r.unitId));
      if (rows.length) this.store.embeddings.put(name, ownerId, key, rows);
      return rows.length;
    })().finally(() => this.pending.delete(tag));
    this.pending.set(tag, job);
    return job;
  }

  /**
   * Brings every corpus up to the current settings: each corpus's own upkeep
   * (every mode), then embeds whatever the current model has no vectors for,
   * dropping vectors from old models.
   */
  async backfill(log = () => {}) {
    for (const corpus of this.corpora.values()) corpus.maintain?.(this, log);
    if (!this.embedder) return 0;
    const pruned = this.store.embeddings.prune(this.embedder.key);
    if (pruned) log(`dropped ${pruned} chunk vector(s) from a previous model or chunking`);
    let total = 0;
    for (const [name, corpus] of this.corpora) {
      let n = 0;
      for (const owner of corpus.ownersMissing(this.embedder.key)) n += await this.ingest(name, owner);
      if (n) log(`embedded ${n} ${name} unit(s) for ${this.mode} retrieval`);
      total += n;
    }
    return total;
  }

  /** The passage split new documents get. */
  passageSettings() {
    return { passageSize: this.cfg.passageSize ?? 1800, passageOverlap: this.cfg.passageOverlap ?? 200 };
  }

  /**
   * The best units of a corpus for a query, as that corpus hydrates them,
   * each with the scores that ranked it. Same call in every mode.
   */
  async search(name, scope, query, limit = 5) {
    const corpus = this.#corpus(name);
    if (!String(query ?? '').trim()) return [];
    if (this.mode === 'lexical') {
      // Every query word must match, like a search box; best BM25 first.
      const hits = [...corpus.lexical(scope, query, { any: false })]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([id, s]) => ({ id, rank: s, dense: null, bm25: s }));
      return corpus.hydrate(hits, scope);
    }
    for (const owner of corpus.ownersOf?.(scope) || []) await this.ingest(name, owner);
    const ids = corpus.candidates(scope);
    if (!ids.length) return [];
    const vectors = this.store.embeddings.vectors(name, this.embedder.key, ids);
    const [q] = await this.embedder.embed([(this.cfg.queryPrefix || '') + query]);
    const dense = ids.map((id) => (vectors.has(id) ? Math.max(...vectors.get(id).map((v) => cosine(q, v))) : -1));
    const lexical = corpus.lexical(scope, query, { any: true });
    const bm25 = ids.map((id) => lexical.get(id) ?? 0);
    const denseWeight = this.mode === 'dense' ? 1 : (this.cfg.denseWeight ?? 0.5);
    const hits = fuse(bm25, dense, { denseWeight, k: this.cfg.rrfK ?? 60 })
      .slice(0, limit)
      .map(({ index, rrf, dense: d, bm25: b }) => ({ id: ids[index], rank: rrf, dense: d, bm25: b }));
    return corpus.hydrate(hits, scope);
  }
}
