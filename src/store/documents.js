import { scope, ftsQuery } from './scope.js';
import { createHash, randomBytes } from 'node:crypto';
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

const md5Of = (bytes) => createHash('md5').update(bytes).digest('hex');

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

  /**
   * `original`: the uploaded bytes, kept (once per distinct file) so the file
   * itself can be opened later. `md5` names them when the caller already has
   * the fingerprint, e.g. copying a document into another chat.
   */
  add(chatId, { filename, mime, content, original = null, md5 = null }, { passageSize = PASSAGE_SIZE, passageOverlap = PASSAGE_OVERLAP } = {}) {
    const id = randomBytes(12).toString('hex');
    const createdAt = Date.now();
    const hash = original ? md5Of(original) : md5;
    this.db.exec('BEGIN');
    try {
      if (original) this.db.prepare('INSERT OR IGNORE INTO document_blobs (md5, data) VALUES (?, ?)').run(hash, original);
      this.db.prepare(`
        INSERT INTO documents (id, chat_id, filename, mime, char_len, created_at, content, passage_size, passage_overlap, md5)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, chatId, filename, mime ?? null, content.length, createdAt, content, passageSize, passageOverlap, hash);
      const passages = insertPassages(this.db, id, chatId, content, passageSize, passageOverlap);
      this.db.exec('COMMIT');
      return { id, filename, mime: mime ?? null, char_len: content.length, created_at: createdAt, passages };
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }

  /** The chat's document with these bytes, if it already has one -- a file is attached to a chat once. */
  findInChat(chatId, original) {
    return this.#inChat(chatId, md5Of(original));
  }

  #inChat(chatId, md5) {
    return this.db.prepare('SELECT id, filename, mime, char_len, created_at FROM documents WHERE chat_id = ? AND md5 = ?')
      .get(chatId, md5) || null;
  }

  /** The uploaded bytes as a Buffer, or null (no such document, not yours, or stored before originals were kept). */
  original(id, userId) {
    const doc = this.get(id, userId);
    if (!doc?.md5) return null;
    const row = this.db.prepare('SELECT data FROM document_blobs WHERE md5 = ?').get(doc.md5);
    return row ? Buffer.from(row.data) : null;
  }

  /**
   * What the user has attached before, across all their chats, newest first --
   * for picking a file again without uploading it. One entry per distinct file:
   * the same bytes in ten chats is one line, and it names the latest chat.
   */
  library(userId, limit = 200) {
    const s = scope(userId, 'c.user_id');
    const inner = scope(userId, 'c2.user_id'); // the "latest" must be the user's own copy, not someone else's
    return this.db.prepare(`
      SELECT d.id, d.filename, d.mime, d.char_len, d.created_at, c.title AS chatTitle
      FROM documents d JOIN chats c ON c.id = d.chat_id
      WHERE ${s.sql}
        AND d.id = (
          SELECT d2.id FROM documents d2 JOIN chats c2 ON c2.id = d2.chat_id
          WHERE ${inner.sql} AND COALESCE(d2.md5, d2.id) = COALESCE(d.md5, d.id)
          ORDER BY d2.created_at DESC, d2.rowid DESC LIMIT 1
        )
      ORDER BY d.created_at DESC
      LIMIT ?
    `).all(...s.params, ...inner.params, limit);
  }

  /**
   * Puts a copy of one of the user's documents into another chat of theirs.
   * Documents are chat-scoped (the chat's deletion takes them, its passages
   * carry its id), so this is a new row: same text, same file blob, its own
   * passages. Null when the source is not theirs; the chat's existing copy
   * when it already has this file.
   */
  copyToChat(sourceId, chatId, userId, passageSettings) {
    const src = this.get(sourceId, userId);
    if (!src) return null;
    if (src.md5) {
      const have = this.#inChat(chatId, src.md5);
      if (have) return { ...have, existing: true };
    }
    return this.add(chatId, { filename: src.filename, mime: src.mime, content: src.content, md5: src.md5 }, passageSettings);
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
    const gone = this.db.prepare('DELETE FROM documents WHERE id = ?').run(id).changes > 0;
    this.#dropOrphanBlobs();
    return gone;
  }

  /** Drops every document of a chat, with its passages and vectors (the chat is going). */
  deleteForChat(chatId) {
    for (const { id } of this.db.prepare('SELECT id FROM documents WHERE chat_id = ?').all(chatId)) this.#deletePassages(id);
    this.db.prepare('DELETE FROM documents WHERE chat_id = ?').run(chatId);
    this.#dropOrphanBlobs();
  }

  /** A stored file goes when the last document naming it does. */
  #dropOrphanBlobs() {
    this.db.exec('DELETE FROM document_blobs WHERE md5 NOT IN (SELECT md5 FROM documents WHERE md5 IS NOT NULL)');
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
