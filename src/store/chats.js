import { ALL_USERS, scope, ownerOf } from './scope.js';
import { randomUUID } from 'node:crypto';
import { CORPUS } from './embeddings.js';

// Chats and what hangs off one: tasks, folders, queued input, ask_user questions, rewind and delete.
// One area of the Store; see index.js.

export class ChatStore {
  constructor(db, deps = {}) {
    this.db = db;
    Object.assign(this, deps);
  }

  listTasks(chatId) {
    return this.db.prepare('SELECT id, title, status, created_at, updated_at FROM tasks WHERE chat_id = ? ORDER BY created_at, rowid').all(chatId);
  }

  /**
   * Task writes are stamped with the seq of the latest saved message: the
   * assistant message that made the call, which is saved before its tools run.
   * That seq lies inside the turn, after its question, so rewinding to the
   * question (or retrying its answer) undoes the write -- and it holds even if
   * the turn dies before saving anything more. See undoTasksFrom.
   */
  addTask(chatId, title) {
    const id = randomUUID();
    const now = Date.now();
    this.db.prepare('INSERT INTO tasks (id, chat_id, title, created_at, updated_at, created_seq) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, chatId, title, now, now, this.#stamp(chatId));
    return this.listTasks(chatId).find((task) => task.id === id);
  }

  updateTask(chatId, id, status) {
    const prev = this.db.prepare('SELECT status FROM tasks WHERE chat_id = ? AND id = ?').get(chatId, id);
    if (!prev) return null;
    this.db.prepare('INSERT INTO task_changes (chat_id, task_id, seq, prev_status) VALUES (?, ?, ?, ?)')
      .run(chatId, id, this.#stamp(chatId), prev.status);
    this.db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE chat_id = ? AND id = ?')
      .run(status, Date.now(), chatId, id);
    return this.listTasks(chatId).find((task) => task.id === id);
  }

  #stamp(chatId) {
    return this.messages.nextSeq(chatId) - 1;
  }

  /** Undoes the checklist writes made from `seq` on: changes newest first, then the tasks added. */
  undoTasksFrom(chatId, seq) {
    const changes = this.db.prepare(
      'SELECT rowid, task_id, prev_status FROM task_changes WHERE chat_id = ? AND seq >= ? ORDER BY rowid DESC'
    ).all(chatId, seq);
    const restore = this.db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE chat_id = ? AND id = ?');
    for (const c of changes) restore.run(c.prev_status, Date.now(), chatId, c.task_id);
    this.db.prepare('DELETE FROM task_changes WHERE chat_id = ? AND seq >= ?').run(chatId, seq);
    this.db.prepare('DELETE FROM tasks WHERE chat_id = ? AND created_seq >= ?').run(chatId, seq);
  }

  create({ id, title = 'New chat', createdAt = Date.now() } = {}, userId = ALL_USERS) {
    const chatId = id || randomUUID();
    this.db.prepare(
      'INSERT INTO chats (id, title, created_at, updated_at, user_id) VALUES (?, ?, ?, ?, ?)'
    ).run(chatId, title, createdAt, createdAt, ownerOf(userId));
    return this.byId(chatId);
  }

  /** Scoped lookup for anything reached from a request. See scope(). */
  get(id, userId) {
    const s = scope(userId);
    return this.db.prepare(`SELECT * FROM chats WHERE id = ? AND ${s.sql}`).get(id, ...s.params) || null;
  }

  /** Unscoped lookup for internal plumbing that already holds a chat id it
   * got from a scoped path (the chat loop, compaction, automation runs). */
  byId(id) {
    return this.db.prepare('SELECT * FROM chats WHERE id = ?').get(id) || null;
  }

  list(limit, userId) {
    const s = scope(userId);
    return this.db.prepare(
      `SELECT id, title, updated_at, epoch, boundary_seq, folder FROM chats WHERE ${s.sql} ORDER BY updated_at DESC LIMIT ?`
    ).all(...s.params, limit);
  }

  organize(id, { folder = null, tags } = {}, userId) {
    if (!this.get(id, userId)) return null;
    const clean = (items, max) => [...new Set((Array.isArray(items) ? items : [])
      .map((v) => String(v).trim().slice(0, max)).filter(Boolean))].slice(0, 10);
    const cleanFolder = folder == null ? null : String(folder).trim().slice(0, 40) || null;
    const tagsJson = tags === undefined ? null : JSON.stringify(clean(tags, 32));
    const result = this.db.prepare('UPDATE chats SET folder = ?, tags_json = COALESCE(?, tags_json) WHERE id = ?')
      .run(cleanFolder, tagsJson, id);
    return result.changes ? this.byId(id) : null;
  }

  /** Names only, sorted -- the create-then-move-chats-into-it workflow needs
   * to list folders even when nothing has been organized into them yet. Also
   * pulls in any folder name already sitting on a chat's `folder` column:
   * chats organized before the `folders` table existed (or by anything else
   * that writes that column directly) never ran through createFolder, so the
   * table alone would silently drop them from this list. */
  listFolders(userId) {
    const s = scope(userId);
    const own = this.db.prepare(`SELECT name FROM folders WHERE ${s.sql}`).all(...s.params);
    const used = this.db.prepare(
      `SELECT DISTINCT folder AS name FROM chats WHERE ${s.sql} AND folder IS NOT NULL AND folder != ''`
    ).all(...s.params);
    return [...new Set([...own, ...used].map((r) => r.name))].sort((a, b) => a.localeCompare(b));
  }

  createFolder(name, userId) {
    const clean = String(name || '').trim().slice(0, 40);
    if (!clean) return null;
    const owner = ownerOf(userId);
    const s = scope(owner);
    const exists = this.db.prepare(`SELECT 1 FROM folders WHERE name = ? AND ${s.sql}`).get(clean, ...s.params);
    if (!exists) {
      this.db.prepare('INSERT INTO folders (name, user_id, created_at) VALUES (?, ?, ?)')
        .run(clean, owner, Date.now());
    }
    return clean;
  }

  /**
   * Rewinds a conversation, dropping everything from `seq` onward.
   *
   * This is the one place that breaks the append-only rule on purpose. Editing
   * a question means the answers that followed it were answers to a question
   * that no longer exists, so they go with it -- and the prompt cache from that
   * point on goes too, which is correct rather than unfortunate: the model must
   * genuinely reconsider everything after the edit.
   *
   * Artifacts are left behind. They are addressed by id from a message that no
   * longer exists, so nothing can reach them, and deleting them would be the
   * one way to lose tool output that the transcript promises to keep.
   */
  /**
   * Queues input for a running turn. Returns false when that id is already
   * queued (a retry), true when it was added.
   */
  addQueued(chatId, { id, kind, content }) {
    return this.db.prepare(
      'INSERT OR IGNORE INTO queued_messages (id, chat_id, kind, content, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(String(id), chatId, kind, String(content), Date.now()).changes > 0;
  }

  /** A chat's queue, oldest first. */
  listQueued(chatId) {
    return this.db.prepare(
      'SELECT id, kind, content, created_at FROM queued_messages WHERE chat_id = ? ORDER BY pos'
    ).all(chatId);
  }

  /**
   * Removes and returns queued items for delivery, oldest first: every item
   * of `kind`, or with `first` only the oldest item of any kind.
   */
  takeQueued(chatId, { kind = null, first = false } = {}) {
    const rows = this.db.prepare(
      `SELECT pos, id, kind, content FROM queued_messages WHERE chat_id = ?${kind ? ' AND kind = ?' : ''} ORDER BY pos${first ? ' LIMIT 1' : ''}`
    ).all(...(kind ? [chatId, kind] : [chatId]));
    const drop = this.db.prepare('DELETE FROM queued_messages WHERE pos = ?');
    for (const r of rows) drop.run(r.pos);
    return rows.map(({ id, kind: k, content }) => ({ id, kind: k, content }));
  }

  /** Withdraws one queued item before it is delivered. */
  deleteQueued(chatId, id) {
    return this.db.prepare('DELETE FROM queued_messages WHERE chat_id = ? AND id = ?').run(chatId, String(id)).changes > 0;
  }

  /** Records a question as pending. `deadline` is epoch ms, or null for no timeout. */
  addQuestion(chatId, { id, question, choices = [], allowFreeText = true, deadline = null }) {
    this.db.prepare(
      'INSERT INTO questions (id, chat_id, question, choices_json, allow_free_text, created_at, deadline) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(String(id), chatId, question, JSON.stringify(choices), allowFreeText ? 1 : 0, Date.now(), deadline);
  }

  getQuestion(id) {
    const row = this.db.prepare('SELECT * FROM questions WHERE id = ?').get(String(id));
    return row && {
      id: row.id, chatId: row.chat_id, question: row.question, choices: JSON.parse(row.choices_json),
      allowFreeText: Boolean(row.allow_free_text), status: row.status, answer: row.answer,
      createdAt: row.created_at, deadline: row.deadline, settledAt: row.settled_at
    };
  }

  /**
   * Settles a pending question. True for the one caller that settled it;
   * false when it was already settled (or never existed).
   */
  settleQuestion(id, status, answer = null) {
    return this.db.prepare(
      "UPDATE questions SET status = ?, answer = ?, settled_at = ? WHERE id = ? AND status = 'pending'"
    ).run(status, answer, Date.now(), String(id)).changes > 0;
  }

  /** Expires every pending question: at startup no run is left to answer one. */
  expireQuestions() {
    return this.db.prepare(
      "UPDATE questions SET status = 'expired', settled_at = ? WHERE status = 'pending'"
    ).run(Date.now()).changes;
  }

  truncateFrom(chatId, seq) {
    // One transaction: a crash midway must not leave messages cut but their
    // task writes (or cache markers) still standing.
    this.db.exec('BEGIN');
    try {
      const removed = this.messages.deleteFrom(chatId, seq);
      this.undoTasksFrom(chatId, seq);
      // A frozen compaction boundary inside the cut no longer describes anything,
      // so the pinned cache breakpoint it drives has to go with it.
      const chat = this.byId(chatId);
      if (chat && chat.boundary_seq >= seq) this.touch(chatId, { boundary_seq: -1 });
      // Same for the hard window: a cut at or past the rewind point would hide
      // the very question being asked again.
      if (chat && chat.window_seq >= seq) this.touch(chatId, { window_seq: -1 });
      this.db.exec('COMMIT');
      return removed;
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }

  delete(id, userId) {
    if (!this.get(id, userId)) return false;
    // Each area drops its own part of the chat; tasks go by foreign key.
    this.automations.deleteForChat(id);
    this.messages.deleteForChat(id);
    this.documents.deleteForChat(id);
    this.embeddings.deleteOwner(CORPUS.CHATS, id);
    this.db.prepare('DELETE FROM queued_messages WHERE chat_id = ?').run(id);
    this.db.prepare('DELETE FROM questions WHERE chat_id = ?').run(id);
    this.db.prepare('DELETE FROM chats WHERE id = ?').run(id);
    return true;
  }

  touch(id, patch = {}) {
    const sets = ['updated_at = ?'];
    const vals = [Date.now()];
    for (const key of ['title', 'epoch', 'boundary_seq', 'window_seq']) {
      if (patch[key] !== undefined) { sets.push(`${key} = ?`); vals.push(patch[key]); }
    }
    vals.push(id);
    this.db.prepare(`UPDATE chats SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
}
