import { scope, ftsQuery } from './scope.js';

// Sidebar search: full-text over what was said, one row per chat.
// Methods of Store; see index.js.

export class SearchStore {
  /**
   * Full-text search, one row per matching CHAT, not per matching message --
   * a search box is for finding a conversation, and a chat where the same
   * word landed in five messages should not crowd out four other chats that
   * only said it once. Each chat's own best-ranked message stands for it,
   * and chats are then ordered against each other by that same rank.
   *
   * `bm25()` and `snippet()` are FTS5 auxiliary functions: usable only in a
   * query that itself matches the virtual table, not through an arbitrary
   * subquery. Computing both once in `hits` and carrying the values through
   * `ranked` (rather than recomputing `bm25(messages_fts)` inside the window
   * function's own ORDER BY) is what keeps them legal here -- SQLite raises
   * "unable to use function bm25 in the requested context" otherwise.
   */
  search(query, limit, userId) {
    const s = scope(userId, 'c.user_id');
    const q = ftsQuery(query);
    if (!q) return [];
    return this.db.prepare(`
      WITH hits AS (
        SELECT
          m.chat_id  AS chatId,
          c.title    AS chatTitle,
          m.seq      AS seq,
          m.role     AS role,
          c.updated_at AS chatUpdatedAt,
          bm25(messages_fts) AS rank,
          snippet(messages_fts, 0, '‹', '›', '…', 12) AS snippet
        FROM messages_fts
        JOIN messages m ON m.id = messages_fts.rowid
        JOIN chats c ON c.id = m.chat_id
        WHERE messages_fts MATCH ? AND ${s.sql}
      ),
      ranked AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY chatId ORDER BY rank) AS rn
        FROM hits
      )
      SELECT chatId, chatTitle, seq, role, chatUpdatedAt, snippet
      FROM ranked
      WHERE rn = 1
      ORDER BY rank
      LIMIT ?
    `).all(q, ...s.params, limit);
  }
}
