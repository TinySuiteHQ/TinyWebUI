import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ChatMessage, Role } from '../harness/types.ts';
import { scope, type Scope } from './scope.ts';

/** An image as a message carries it: base64 bytes, already normalised for the wire. */
export interface MessageImage { mime: string; data: string; [key: string]: unknown }

export interface MessageRow {
  id: number;
  chat_id: string;
  seq: number;
  role: Role;
  content: string | null;
  tool_call_id: string | null;
  tool_calls_json: string | null;
  reasoning: string | null;
  reasoning_details_json: string | null;
  artifact_id: string | null;
  stub_text: string | null;
  usage_json: string | null;
  model: string | null;
  created_at: number | null;
  images_json: string | null;
  images_dropped: number;
  origin_json: string | null;
}

/** What add() stores: a message plus what rides along with it in the row. */
export interface NewMessage extends Omit<ChatMessage, 'content'> {
  content?: string | null;
  artifact_id?: string | null;
  stub_text?: string | null;
  usage?: object;
  model?: string;
  images?: MessageImage[];
  origin?: object;
}

/** One image the user attached, without its bytes: what the Files page lists. */
export interface ImageSummary {
  messageId: number;
  index: number;
  chatId: string;
  chatTitle: string;
  filename: string | null;
  mime: string;
  created_at: number | null;
}

export interface ArtifactRow {
  id: string;
  chat_id: string;
  tool_name: string;
  args_json: string | null;
  content: string;
  char_len: number;
  created_at: number;
  user_id: string | null;
}

// The transcript: messages in order, and the tool-result artifacts behind them.
// One area of the Store; see index.js.

export class MessageStore {
  db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  claimUnownedArtifacts(userId: string): void {
    this.db.prepare('UPDATE artifacts SET user_id = ? WHERE user_id IS NULL').run(userId);
  }

  nextSeq(chatId: string): number {
    const row = this.db.prepare('SELECT MAX(seq) AS m FROM messages WHERE chat_id = ?').get(chatId) as { m: number | null } | undefined;
    return (row?.m ?? -1) + 1;
  }

  /** Drops a chat's messages from `seq` on (a rewind). Returns how many went. */
  deleteFrom(chatId: string, seq: number): number {
    return this.db.prepare('DELETE FROM messages WHERE chat_id = ? AND seq >= ?').run(chatId, seq).changes as number;
  }

  /** Drops a chat's whole transcript and the artifacts behind it (the chat is going). */
  deleteForChat(chatId: string): void {
    this.db.prepare('DELETE FROM messages WHERE chat_id = ?').run(chatId);
    this.db.prepare('DELETE FROM artifacts WHERE chat_id = ?').run(chatId);
  }

  /** Appends one message. Append-only by design: rows are never reordered. */
  add(chatId: string, msg: NewMessage): number {
    const seq = this.nextSeq(chatId);
    this.db.prepare(`
      INSERT INTO messages
        (chat_id, seq, role, content, tool_call_id, tool_calls_json,
         reasoning, reasoning_details_json, artifact_id, stub_text, usage_json,
         model, created_at, images_json, origin_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      chatId, seq, msg.role,
      msg.content ?? null,
      msg.tool_call_id ?? null,
      msg.tool_calls ? JSON.stringify(msg.tool_calls) : null,
      msg.reasoning ?? null,
      msg.reasoning_details ? JSON.stringify(msg.reasoning_details) : null,
      msg.artifact_id ?? null,
      msg.stub_text ?? null,
      msg.usage ? JSON.stringify(msg.usage) : null,
      msg.model ?? null,
      Date.now(),
      msg.images ? JSON.stringify(msg.images) : null,
      msg.origin ? JSON.stringify(msg.origin) : null
    );
    return seq;
  }

  updateUsage(chatId: string, seq: number, usage: object): void {
    this.db.prepare('UPDATE messages SET usage_json = ? WHERE chat_id = ? AND seq = ?')
      .run(JSON.stringify(usage), chatId, seq);
  }

  list(chatId: string): MessageRow[] {
    return this.db.prepare(
      'SELECT * FROM messages WHERE chat_id = ? ORDER BY seq ASC'
    ).all(chatId) as unknown as MessageRow[];
  }

  /**
   * Writes a stub onto an already-stored tool message. This is the ONE place
   * history is rewritten, and it happens only at an epoch boundary. `content`
   * is left untouched so the human transcript keeps the full output -- only
   * what goes to the model shrinks.
   */
  setStub(messageId: number, stubText: string): void {
    this.db.prepare('UPDATE messages SET stub_text = ? WHERE id = ?').run(stubText, messageId);
  }

  /** Takes a message's images off the wire at an epoch; the transcript keeps them. */
  dropImages(messageId: number): void {
    this.db.prepare('UPDATE messages SET images_dropped = 1 WHERE id = ?').run(messageId);
  }

  /**
   * Every image the user attached, newest first, for the Files page. json_each
   * reads the metadata inside SQLite, so the base64 bytes never leave it here.
   */
  imageLibrary(userId: Scope, limit = 300): ImageSummary[] {
    const s = scope(userId, 'c.user_id');
    return this.db.prepare(`
      SELECT m.id AS messageId, CAST(j.key AS INTEGER) AS "index", m.chat_id AS chatId, c.title AS chatTitle,
             json_extract(j.value, '$.filename') AS filename, json_extract(j.value, '$.mime') AS mime, m.created_at
      FROM messages m JOIN chats c ON c.id = m.chat_id, json_each(m.images_json) j
      WHERE m.images_json IS NOT NULL AND m.role = 'user' AND ${s.sql}
      ORDER BY m.created_at DESC, m.id DESC, j.key ASC
      LIMIT ?
    `).all(...s.params, limit) as unknown as ImageSummary[];
  }

  /** One attached image's bytes, or null (no such image, or not the user's). */
  image(messageId: number, index: number, userId: Scope): { mime: string; data: Buffer } | null {
    if (!Number.isSafeInteger(index) || index < 0) return null;
    const s = scope(userId, 'c.user_id');
    // The path is built here, not in SQL: node:sqlite binds a JS number as a
    // REAL, and '$[0.0]' is not a JSON path.
    const at = `$[${index}]`;
    const row = this.db.prepare(`
      SELECT json_extract(m.images_json, ? || '.mime') AS mime, json_extract(m.images_json, ? || '.data') AS data
      FROM messages m JOIN chats c ON c.id = m.chat_id
      WHERE m.id = ? AND m.images_json IS NOT NULL AND ${s.sql}
    `).get(at, at, messageId, ...s.params) as { mime: unknown; data: unknown } | undefined;
    if (!row || typeof row.mime !== 'string' || typeof row.data !== 'string') return null;
    return { mime: row.mime, data: Buffer.from(row.data, 'base64') };
  }

  addArtifact(chatId: string, { toolName, args, content }: { toolName: string; args?: unknown; content: string }): string {
    const id = randomBytes(12).toString('hex');
    this.db.prepare(`
      INSERT INTO artifacts (id, chat_id, tool_name, args_json, content, char_len, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, chatId, toolName, JSON.stringify(args ?? {}), content, content.length, Date.now());
    return id;
  }

  getArtifact(id: string, chatId: string): ArtifactRow | null {
    return (this.db.prepare('SELECT * FROM artifacts WHERE id = ? AND chat_id = ?').get(id, chatId) as ArtifactRow | undefined) || null;
  }
}
