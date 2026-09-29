// Chunk vectors for every retrieval corpus (see retrieval/retrieval.js).
// One area of the Store; see index.js.

export class EmbeddingStore {
  constructor(db, deps = {}) {
    this.db = db;
    Object.assign(this, deps);
  }

  /** Chunk vectors of the given units under one model: Map(unit id -> Float32Array[], one per chunk). */
  vectors(corpus, modelKey, unitIds) {
    const out = new Map();
    if (!unitIds.length) return out;
    const rows = this.db.prepare(`
      SELECT unit_id, vec FROM embeddings
      WHERE corpus = ? AND model_key = ? AND unit_id IN (SELECT value FROM json_each(?))
      ORDER BY unit_id, chunk
    `).all(corpus, modelKey, JSON.stringify(unitIds));
    for (const r of rows) {
      const buf = r.vec;
      if (!out.has(r.unit_id)) out.set(r.unit_id, []);
      out.get(r.unit_id).push(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4).slice());
    }
    return out;
  }

  /** What each of an owner's units was embedded from: Map(unit id -> digest). */
  digests(corpus, ownerId, modelKey) {
    const rows = this.db.prepare('SELECT unit_id, digest FROM embeddings WHERE corpus = ? AND owner_id = ? AND model_key = ? AND chunk = 0')
      .all(corpus, ownerId, modelKey);
    return new Map(rows.map((r) => [r.unit_id, r.digest]));
  }

  /** rows: [{ unitId, digest, vecs: Float32Array[] (its chunks, in order) }], replacing what those units had. */
  put(corpus, ownerId, modelKey, rows) {
    const clear = this.db.prepare('DELETE FROM embeddings WHERE corpus = ? AND unit_id = ? AND model_key = ?');
    const put = this.db.prepare('INSERT INTO embeddings (corpus, unit_id, owner_id, model_key, digest, chunk, vec) VALUES (?, ?, ?, ?, ?, ?, ?)');
    this.db.exec('BEGIN');
    try {
      for (const { unitId, digest, vecs } of rows) {
        clear.run(corpus, unitId, modelKey);
        vecs.forEach((vec, chunk) => put.run(corpus, unitId, ownerId, modelKey, digest, chunk, Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength)));
      }
      this.db.exec('COMMIT');
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }

  /** Drops an owner's vectors for units it no longer has. */
  dropStale(corpus, ownerId, keepUnitIds) {
    return this.db.prepare(`
      DELETE FROM embeddings WHERE corpus = ? AND owner_id = ? AND unit_id NOT IN (SELECT value FROM json_each(?))
    `).run(corpus, ownerId, JSON.stringify(keepUnitIds)).changes;
  }

  /** Drops vectors from models (or chunkings) no longer configured. */
  prune(keepModelKey) {
    return this.db.prepare('DELETE FROM embeddings WHERE model_key != ?').run(keepModelKey).changes;
  }
}
