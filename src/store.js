import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Conversation storage.
 *
 * The client used to hold the whole transcript and POST it back every turn,
 * which meant every tool result -- including page-sized ones -- crossed the wire
 * again on each message and eventually blew the localStorage quota. State lives
 * here now, and the client sends only the new user message.
 *
 * Two things this file deliberately does NOT do: it never parses tool output,
 * and it never special-cases a tool name. A tool result is an opaque blob from
 * an arbitrary MCP server. Everything downstream (compaction, expansion) holds
 * to the same rule.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chats (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  epoch        INTEGER NOT NULL DEFAULT 0,
  boundary_seq INTEGER NOT NULL DEFAULT -1
);

CREATE TABLE IF NOT EXISTS messages (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id                TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  seq                    INTEGER NOT NULL,
  role                   TEXT NOT NULL,
  content                TEXT,
  tool_call_id           TEXT,
  tool_calls_json        TEXT,
  reasoning              TEXT,
  reasoning_details_json TEXT,
  artifact_id            TEXT,
  stub_text              TEXT,
  usage_json             TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS messages_chat_seq ON messages(chat_id, seq);

CREATE TABLE IF NOT EXISTS artifacts (
  id         TEXT PRIMARY KEY,
  chat_id    TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  tool_name  TEXT NOT NULL,
  args_json  TEXT,
  content    TEXT NOT NULL,
  char_len   INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
`;

export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  close() {
    try { this.db.close(); } catch { /* already gone */ }
  }

  /* ---------- chats ---------- */

  createChat({ id, title = 'New chat', createdAt = Date.now() } = {}) {
    const chatId = id || String(createdAt) + '-' + randomBytes(3).toString('hex');
    this.db.prepare(
      'INSERT INTO chats (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)'
    ).run(chatId, title, createdAt, createdAt);
    return this.getChat(chatId);
  }

  getChat(id) {
    return this.db.prepare('SELECT * FROM chats WHERE id = ?').get(id) || null;
  }

  listChats(limit = 200) {
    return this.db.prepare(
      'SELECT id, title, updated_at, epoch, boundary_seq FROM chats ORDER BY updated_at DESC LIMIT ?'
    ).all(limit);
  }

  deleteChat(id) {
    this.db.prepare('DELETE FROM messages WHERE chat_id = ?').run(id);
    this.db.prepare('DELETE FROM artifacts WHERE chat_id = ?').run(id);
    this.db.prepare('DELETE FROM chats WHERE id = ?').run(id);
  }

  touchChat(id, patch = {}) {
    const sets = ['updated_at = ?'];
    const vals = [Date.now()];
    for (const key of ['title', 'epoch', 'boundary_seq']) {
      if (patch[key] !== undefined) { sets.push(`${key} = ?`); vals.push(patch[key]); }
    }
    vals.push(id);
    this.db.prepare(`UPDATE chats SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  /* ---------- messages ---------- */

  nextSeq(chatId) {
    const row = this.db.prepare('SELECT MAX(seq) AS m FROM messages WHERE chat_id = ?').get(chatId);
    return (row?.m ?? -1) + 1;
  }

  /** Appends one message. Append-only by design: rows are never reordered. */
  addMessage(chatId, msg) {
    const seq = this.nextSeq(chatId);
    this.db.prepare(`
      INSERT INTO messages
        (chat_id, seq, role, content, tool_call_id, tool_calls_json,
         reasoning, reasoning_details_json, artifact_id, stub_text, usage_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      chatId, seq, msg.role,
      msg.content ?? null,
      msg.tool_call_id ?? null,
      msg.tool_calls ? JSON.stringify(msg.tool_calls) : null,
      msg.reasoning ?? null,
      msg.reasoning_details ? JSON.stringify(msg.reasoning_details) : null,
      msg.artifact_id ?? null,
      msg.stub_text ?? null,
      msg.usage ? JSON.stringify(msg.usage) : null
    );
    return seq;
  }

  messages(chatId) {
    return this.db.prepare(
      'SELECT * FROM messages WHERE chat_id = ? ORDER BY seq ASC'
    ).all(chatId);
  }

  /**
   * Writes a stub onto an already-stored tool message. This is the ONE place
   * history is rewritten, and it happens only at an epoch boundary. `content`
   * is left untouched so the human transcript keeps the full output -- only
   * what goes to the model shrinks.
   */
  setStub(messageId, stubText) {
    this.db.prepare('UPDATE messages SET stub_text = ? WHERE id = ?').run(stubText, messageId);
  }

  /* ---------- artifacts ---------- */

  addArtifact(chatId, { toolName, args, content }) {
    const id = randomBytes(4).toString('hex');
    this.db.prepare(`
      INSERT INTO artifacts (id, chat_id, tool_name, args_json, content, char_len, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, chatId, toolName, JSON.stringify(args ?? {}), content, content.length, Date.now());
    return id;
  }

  getArtifact(id) {
    return this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) || null;
  }
}

/* ---------- row <-> message shapes ---------- */

function base(row) {
  const msg = { role: row.role };
  if (row.tool_call_id) msg.tool_call_id = row.tool_call_id;
  if (row.tool_calls_json) msg.tool_calls = JSON.parse(row.tool_calls_json);
  if (row.reasoning_details_json) msg.reasoning_details = JSON.parse(row.reasoning_details_json);
  return msg;
}

/**
 * What the model sees. A demoted tool message sends its stub; everything else
 * sends its content verbatim. Reasoning text is dropped here -- `buildMessages`
 * in llm.js strips it anyway, and it has no place in a cached prefix.
 */
export function toWire(row) {
  const msg = base(row);
  msg.content = row.role === 'tool' ? (row.stub_text ?? row.content) : (row.content ?? null);
  return msg;
}

/** What the transcript shows: always the full text, stub or not. */
export function toView(row) {
  const msg = base(row);
  msg.content = row.content ?? null;
  if (row.reasoning) msg.reasoning = row.reasoning;
  if (row.usage_json) msg.usage = JSON.parse(row.usage_json);
  if (row.stub_text) msg.compacted = true;
  return msg;
}
