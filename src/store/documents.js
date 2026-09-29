import { scope, ftsQuery } from './scope.js';
import { randomBytes } from 'node:crypto';
import { CORPUS } from './embeddings.js';

// Attached documents, split into passages for read_document (BM25 and dense retrieval).
// One area of the Store; see index.js.

/** Default passage split: characters per passage, and how much neighbours overlap. */
export const PASSAGE_SIZE = 1800;
export const PASSAGE_OVERLAP = 200;

/**
 * Splits text into overlapping passages -- the unit read_document returns.
 * Character-based on purpose: passages are for reading and BM25, and the
 * embedding side cuts its own model-sized chunks out of them. Breaks are
 * nudged onto a paragraph or line boundary when one is nearby, so a
 * passage doesn't open or close mid-sentence more than it has to.
 */
export function splitPassages(text, size = PASSAGE_SIZE, overlap = PASSAGE_OVERLAP) {
  const passages = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + size, text.length);
    if (end < text.length) {
      const para = text.lastIndexOf('\n\n', end);
      const line = text.lastIndexOf('\n', end);
      const boundary = para > start + size * 0.5 ? para : (line > start + size * 0.5 ? line : -1);
      if (boundary !== -1) end = boundary;
    }
    passages.push({ start, text: text.slice(start, end) });
    if (end >= text.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return passages;
}

function insertPassages(db, docId, chatId, content, size, overlap) {
  const passages = splitPassages(content, size, overlap);
  const insertPassage = db.prepare('INSERT INTO document_passages (body) VALUES (?)');
  const insertMap = db.prepare(`
    INSERT INTO document_passage_map (passage_rowid, doc_id, chat_id, passage_idx, char_start)
    VALUES (?, ?, ?, ?, ?)
  `);
  passages.forEach((passage, idx) => {
    const { lastInsertRowid } = insertPassage.run(passage.text);
    insertMap.run(lastInsertRowid, docId, chatId, idx, passage.start);
  });
  return passages.length;
}

export class DocumentStore {
  constructor(db, deps = {}) {
    this.db = db;
    Object.assign(this, deps);
  }

  add(chatId, { filename, mime, content }, { passageSize = PASSAGE_SIZE, passageOverlap = PASSAGE_OVERLAP } = {}) {
    const id = randomBytes(12).toString('hex');
    const createdAt = Date.now();
    this.db.prepare(`
      INSERT INTO documents (id, chat_id, filename, mime, char_len, created_at, content, passage_size, passage_overlap)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, chatId, filename, mime ?? null, content.length, createdAt, content, passageSize, passageOverlap);
    const passages = insertPassages(this.db, id, chatId, content, passageSize, passageOverlap);
    return { id, filename, mime: mime ?? null, char_len: content.length, created_at: createdAt, passages };
  }

  /** Documents split with other passage settings than these (NULL = the original 1800/200). */
  withOtherPassages(size, overlap) {
    return this.db.prepare(`
      SELECT id FROM documents
      WHERE COALESCE(passage_size, ${PASSAGE_SIZE}) != ? OR COALESCE(passage_overlap, ${PASSAGE_OVERLAP}) != ?
    `).all(size, overlap).map((r) => r.id);
  }

  /** Re-splits a stored document with new passage settings; its old vectors go with the old passages. */
  repassage(docId, size, overlap) {
    const doc = this.db.prepare('SELECT id, chat_id, content FROM documents WHERE id = ?').get(docId);
    if (!doc) return 0;
    this.db.exec('BEGIN');
    try {
      this.#deletePassages(docId);
      const n = insertPassages(this.db, doc.id, doc.chat_id, doc.content, size, overlap);
      this.db.prepare('UPDATE documents SET passage_size = ?, passage_overlap = ? WHERE id = ?').run(size, overlap, docId);
      this.db.exec('COMMIT');
      return n;
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }

  /** Scoped through the owning chat: a document is its chat's user's. */
  get(id, userId) {
    const s = scope(userId, 'c.user_id');
    return this.db.prepare(
      `SELECT d.* FROM documents d JOIN chats c ON c.id = d.chat_id WHERE d.id = ? AND ${s.sql}`
    ).get(id, ...s.params) || null;
  }

  list(chatId) {
    return this.db.prepare(`
      SELECT id, filename, mime, char_len, created_at
      FROM documents WHERE chat_id = ? ORDER BY created_at ASC
    `).all(chatId);
  }

  /** Drops one document, its passages and their chunk vectors. The rest of the chat is untouched. */
  delete(id, userId) {
    if (!this.get(id, userId)) return false;
    this.#deletePassages(id);
    return this.db.prepare('DELETE FROM documents WHERE id = ?').run(id).changes > 0;
  }

  /** Drops every document of a chat, with its passages and vectors (the chat is going). */
  deleteForChat(chatId) {
    for (const { id } of this.db.prepare('SELECT id FROM documents WHERE chat_id = ?').all(chatId)) this.#deletePassages(id);
    this.db.prepare('DELETE FROM documents WHERE chat_id = ?').run(chatId);
  }

  // FTS5 has no foreign keys of its own, so passage rows are dropped by rowid
  // before the map that names them.
  #deletePassages(docId) {
    this.db.prepare(`
      DELETE FROM document_passages WHERE rowid IN (
        SELECT passage_rowid FROM document_passage_map WHERE doc_id = ?
      )
    `).run(docId);
    this.embeddings.deleteOwner(CORPUS.DOCUMENTS, docId);
    this.db.prepare('DELETE FROM document_passage_map WHERE doc_id = ?').run(docId);
  }

  /** Ranked passage search within one document, via FTS5 bm25() (lexical mode). */
  searchPassages(docId, query, limit = 5) {
    const q = ftsQuery(query);
    if (!q) return [];
    return this.db.prepare(`
      SELECT m.passage_idx AS passageIdx, m.char_start AS charStart,
             document_passages.body AS body, bm25(document_passages) AS rank
      FROM document_passages
      JOIN document_passage_map m ON m.passage_rowid = document_passages.rowid
      WHERE document_passages MATCH ? AND m.doc_id = ?
      ORDER BY rank
      LIMIT ?
    `).all(q, docId, limit);
  }

  /** Every passage of a document, in order -- the candidate set for dense and hybrid ranking. */
  passages(docId) {
    return this.db.prepare(`
      SELECT m.passage_rowid AS rowid, m.passage_idx AS passageIdx, m.char_start AS charStart, document_passages.body AS body
      FROM document_passage_map m JOIN document_passages ON document_passages.rowid = m.passage_rowid
      WHERE m.doc_id = ? ORDER BY m.passage_idx
    `).all(docId);
  }

  /**
   * BM25 scores per passage, higher is better. `any`: any query word may
   * match (the hybrid's lexical side, so partial matches still rank above
   * none -- dense ranking handles the rest); otherwise all of them must.
   */
  lexicalScores(docId, query, { any = true } = {}) {
    const q = ftsQuery(query, { any });
    if (!q) return new Map();
    const rows = this.db.prepare(`
      SELECT m.passage_rowid AS rowid, bm25(document_passages) AS rank
      FROM document_passages JOIN document_passage_map m ON m.passage_rowid = document_passages.rowid
      WHERE document_passages MATCH ? AND m.doc_id = ?
    `).all(q, docId);
    return new Map(rows.map((r) => [r.rowid, -r.rank]));
  }

  /** Documents with passages not yet embedded under this model (for backfill). */
  missingVectors(modelKey) {
    return this.db.prepare(`
      SELECT DISTINCT m.doc_id AS id FROM document_passage_map m
      LEFT JOIN embeddings e ON e.corpus = ? AND e.unit_id = m.passage_rowid AND e.model_key = ? AND e.chunk = 0
      WHERE e.unit_id IS NULL
    `).all(CORPUS.DOCUMENTS, modelKey).map((r) => r.id);
  }
}
