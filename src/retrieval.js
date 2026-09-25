/**
 * read_document's ranking: lexical (FTS5 BM25, the default), dense (local
 * embeddings), or hybrid (both, fused).
 *
 * Small-to-big retrieval. A document is split into PASSAGES -- the text
 * read_document hands back (retrieval.passageSize characters). For dense and
 * hybrid search each passage is cut again into CHUNKS sized to the embedding
 * model (its token limit), and every chunk is embedded. A query is matched
 * against the small chunks, each passage takes its best chunk's score, and
 * the model gets the whole big passage. BM25 scores passages directly.
 *
 * The fusion is TinySearch's weighted Reciprocal Rank Fusion
 * (hybrid_embed_search_service.py): each side ranks every passage, which
 * scores
 *
 *     (1 - denseWeight) / (k + bm25Rank) + denseWeight / (k + denseRank)
 *
 * with k = 60 and denseWeight = 0.5 by default, and ties break on the dense
 * score, then the BM25 score, then document order -- fully deterministic.
 *
 * Chunk vectors are computed once, when a document is ingested, stored in
 * SQLite (document_chunks), and reused by every query; only the query itself
 * is embedded at search time.
 */

export const RETRIEVAL_MODES = ['lexical', 'dense', 'hybrid'];

const cosine = (a, b) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
};

/**
 * 1-based competition ranks by descending score: equal scores share a rank
 * (1, 2, 2, 4). One deliberate departure from TinySearch's _rank_by_score,
 * which numbers ties in input order -- there, a query with no BM25 match
 * at all still hands the document's first chunk a lexical lead. Shared ranks
 * make a side that cannot tell chunks apart stay neutral.
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
 * Weighted RRF over parallel score lists. Returns passage indices, best first,
 * with the scores that decided them.
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

/**
 * The retrieval service for one running instance. `embedder` is null in
 * lexical mode; otherwise it is what loadEmbedder() returned (or a stand-in
 * with the same { key, embed } shape, which is how the tests stay offline).
 */
export class Retrieval {
  constructor(store, retrieval, embedder = null) {
    this.store = store;
    this.cfg = retrieval;
    this.mode = retrieval.mode || 'lexical';
    this.embedder = this.mode === 'lexical' ? null : embedder;
    if (this.mode !== 'lexical' && !this.embedder) throw new Error(`retrieval.mode '${this.mode}' needs an embedding model`);
    this.pending = new Map(); // docId -> in-flight ingestion, so a query can wait for it
  }

  /**
   * Embeds the chunks of any of a document's passages that have no vectors
   * for the current model yet, and stores them. Idempotent: an ingested
   * document costs nothing to "ingest" again.
   */
  ingest(docId) {
    if (!this.embedder) return Promise.resolve(0);
    if (this.pending.has(docId)) return this.pending.get(docId);
    const job = (async () => {
      const have = this.store.chunkVectors(docId, this.embedder.key);
      const missing = this.store.documentPassages(docId).filter((p) => !have.has(p.rowid));
      if (!missing.length) return 0;
      const prefix = this.cfg.documentPrefix || '';
      const texts = missing.map((p) => prefix + p.body);
      const vecs = this.embedder.embedPassages
        ? await this.embedder.embedPassages(texts)
        : (await this.embedder.embed(texts)).map((v) => [v]);
      // The document may have been deleted while it was being embedded.
      if (!this.store.documentPassages(docId).length) return 0;
      this.store.putChunkVectors(docId, this.embedder.key, missing.map((p, i) => ({ rowid: p.rowid, vecs: vecs[i] })));
      return missing.length;
    })().finally(() => this.pending.delete(docId));
    this.pending.set(docId, job);
    return job;
  }

  /**
   * Brings every stored document up to the current settings: re-splits any
   * stored with other passage settings (every mode), then embeds whatever
   * the current model has no vectors for, dropping vectors from old ones.
   */
  async backfill(log = () => {}) {
    const { passageSize, passageOverlap } = this.passageSettings();
    const stale = this.store.documentsWithOtherPassages(passageSize, passageOverlap);
    for (const id of stale) this.store.repassageDocument(id, passageSize, passageOverlap);
    if (stale.length) log(`re-split ${stale.length} document(s) into ${passageSize}-character passages`);
    if (!this.embedder) return 0;
    const pruned = this.store.pruneVectors(this.embedder.key);
    if (pruned) log(`dropped ${pruned} chunk vector(s) from a previous model or chunking`);
    let n = 0;
    for (const id of this.store.documentsMissingVectors(this.embedder.key)) n += await this.ingest(id);
    if (n) log(`embedded ${n} passage(s) for ${this.cfg.mode} retrieval`);
    return n;
  }

  /** The passage split new documents get. */
  passageSettings() {
    return { passageSize: this.cfg.passageSize ?? 1800, passageOverlap: this.cfg.passageOverlap ?? 200 };
  }

  /**
   * The best passages of one document for a query, in the shape
   * store.searchPassages() returns, so read_document is the same in every mode.
   */
  async search(docId, query, limit = 5) {
    if (this.mode === 'lexical') return this.store.searchPassages(docId, query, limit);
    await this.ingest(docId);
    const passages = this.store.documentPassages(docId);
    if (!passages.length || !String(query).trim()) return [];
    const vectors = this.store.chunkVectors(docId, this.embedder.key);
    const [q] = await this.embedder.embed([(this.cfg.queryPrefix || '') + query]);
    // Small-to-big: a passage scores by its best-matching chunk.
    const dense = passages.map((p) => (vectors.has(p.rowid) ? Math.max(...vectors.get(p.rowid).map((v) => cosine(q, v))) : -1));
    const lexical = this.store.lexicalScores(docId, query);
    const bm25 = passages.map((p) => lexical.get(p.rowid) ?? 0);
    const denseWeight = this.mode === 'dense' ? 1 : (this.cfg.denseWeight ?? 0.5);
    return fuse(bm25, dense, { denseWeight, k: this.cfg.rrfK ?? 60 })
      .slice(0, limit)
      .map(({ index, rrf, dense: d, bm25: b }) => ({
        passageIdx: passages[index].passageIdx, charStart: passages[index].charStart, body: passages[index].body,
        rank: rrf, dense: d, bm25: b
      }));
  }
}
