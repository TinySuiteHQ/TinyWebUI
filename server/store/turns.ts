import type { DatabaseSync } from 'node:sqlite';
import { scope, ftsQuery, type Scope } from './scope.ts';
import { CORPUS } from './embeddings.ts';
import type { ChatStore } from './chats.ts';

/** A question and the answer it finally got; its id is the user message's id. */
export interface Turn { id: number; chatId: string; seq: number; question: string; answer: string; createdAt: number }

// Chat turns -- a question and its final answer -- the 'chats' retrieval corpus.
// One area of the Store; see index.js.

export class TurnStore {
  declare db: DatabaseSync;
  declare chats: ChatStore;

  constructor(db: DatabaseSync, deps: { chats: ChatStore }) {
    this.db = db;
    Object.assign(this, deps);
  }

  /**
   * A chat's turns: each question with the answer it finally got -- the last
   * assistant message with text before the next question, the one the
   * transcript shows as the answer. A turn's id is its user message's id.
   */
  forChat(chatId: string): Turn[] {
    const rows = this.db.prepare(`
      SELECT id, seq, role, content, created_at FROM messages
      WHERE chat_id = ? AND role IN ('user', 'assistant') ORDER BY seq
    `).all(chatId) as { id: number; seq: number; role: string; content: string | null; created_at: number }[];
    const turns: Turn[] = [];
    for (const r of rows) {
      if (r.role === 'user') turns.push({ id: r.id, chatId, seq: r.seq, question: r.content || '', answer: '', createdAt: r.created_at });
      else if (turns.length && r.content?.trim()) turns.at(-1)!.answer = r.content;
    }
    return turns;
  }

  /** The turns with these ids, each with its chat's title: Map(id -> turn). */
  byIds(ids: number[]): Map<number, Turn & { chatTitle: string }> {
    const chatIds = this.db.prepare(`
      SELECT DISTINCT chat_id FROM messages WHERE role = 'user' AND id IN (SELECT value FROM json_each(?))
    `).all(JSON.stringify(ids)).map((r) => r.chat_id as string);
    const wanted = new Set(ids);
    const out = new Map<number, Turn & { chatTitle: string }>();
    for (const chatId of chatIds) {
      const title = this.chats.byId(chatId)?.title || 'Untitled chat';
      for (const t of this.forChat(chatId)) if (wanted.has(t.id)) out.set(t.id, { ...t, chatTitle: title });
    }
    return out;
  }

  /** Every turn id a user may search, leaving one chat out (the one asking). */
  ids(userId: Scope, { excludeChatId = null }: { excludeChatId?: string | null } = {}): number[] {
    const s = scope(userId, 'c.user_id');
    return this.db.prepare(`
      SELECT m.id FROM messages m JOIN chats c ON c.id = m.chat_id
      WHERE m.role = 'user' AND m.chat_id IS NOT ? AND ${s.sql}
    `).all(excludeChatId, ...s.params).map((r) => r.id as number);
  }

  /** BM25 per turn (its best message), higher is better. `any`: any query word may match. */
  lexicalScores(userId: Scope, query: string, { excludeChatId = null, any = true }: { excludeChatId?: string | null; any?: boolean } = {}): Map<number, number> {
    const q = ftsQuery(query, { any });
    if (!q) return new Map();
    const s = scope(userId, 'c.user_id');
    const rows = this.db.prepare(`
      SELECT bm25(messages_fts) AS rank,
        (SELECT u.id FROM messages u WHERE u.chat_id = m.chat_id AND u.role = 'user' AND u.seq <= m.seq ORDER BY u.seq DESC LIMIT 1) AS turn
      FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid JOIN chats c ON c.id = m.chat_id
      WHERE messages_fts MATCH ? AND m.chat_id IS NOT ? AND ${s.sql}
    `).all(q, excludeChatId, ...s.params) as { rank: number; turn: number | null }[];
    const out = new Map<number, number>();
    for (const r of rows) if (r.turn != null) out.set(r.turn, Math.max(out.get(r.turn) ?? -Infinity, -r.rank));
    return out;
  }

  /** Chats with a question not yet embedded under this model (for backfill). */
  chatsMissingVectors(modelKey: string): string[] {
    return this.db.prepare(`
      SELECT DISTINCT m.chat_id AS id FROM messages m
      LEFT JOIN embeddings e ON e.corpus = ? AND e.unit_id = m.id AND e.model_key = ? AND e.chunk = 0
      WHERE m.role = 'user' AND e.unit_id IS NULL
    `).all(CORPUS.CHATS, modelKey).map((r) => r.id as string);
  }
}
