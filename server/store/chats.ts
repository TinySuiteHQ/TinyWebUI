import { ALL_USERS, scope, ownerOf, type Scope } from './scope.ts';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { CORPUS, type EmbeddingStore } from './embeddings.ts';
import type { MessageRow, MessageStore, RestoredMessage } from './messages.ts';
import type { AutomationStore } from './automations.ts';
import type { DocumentStore, PassageSettings } from './documents.ts';
import { attachmentNote, splitAttachmentNotes } from '../../shared/attachment_note.ts';
import { parseColumn } from './wire.ts';

export interface ChatRow {
  id: string;
  user_id: string | null;
  title: string;
  created_at: number;
  updated_at: number;
  epoch: number;
  boundary_seq: number;
  window_seq: number;
  checkpoint_json: string | null;
  folder: string | null;
  tags_json: string;
  /** An automation run finished here and the owner has not opened it since. */
  unread_at: number | null;
  /** A fork: the chat it was branched from (which may since be gone), and the last seq it copied. */
  parent_id: string | null;
  fork_seq: number | null;
}

export type ChatListing = Pick<ChatRow, 'id' | 'title' | 'updated_at' | 'epoch' | 'boundary_seq' | 'folder' | 'unread_at' | 'parent_id' | 'fork_seq'>;
export type ChatPatch = Partial<Pick<ChatRow, 'title' | 'epoch' | 'boundary_seq' | 'window_seq' | 'checkpoint_json'>>;

export type TaskStatus = 'pending' | 'in_progress' | 'completed';
export interface Task { id: string; title: string; status: TaskStatus; created_at: number; updated_at: number }

/** A task as a backup carries it: with the seq that a rewind compares against. */
export interface TaskRecord extends Task { created_seq: number }

/**
 * A chat as it comes back from a backup (server/transfer/backup.ts), already
 * checked: restore() writes it as given. Its id is free, and its folder exists.
 */
export interface RestoredChat {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  folder: string | null;
  tagsJson: string;
  parentId: string | null;
  forkSeq: number | null;
  epoch: number;
  windowSeq: number;
  checkpointJson: string | null;
  tasks: { title: string; status: TaskStatus; createdAt: number; updatedAt: number; createdSeq: number }[];
  messages: RestoredMessage[];
}

export type QueueKind = 'steer' | 'followup';
export interface QueuedItem { id: string; kind: QueueKind; content: string }

export type QuestionStatus = 'pending' | 'answered' | 'timeout' | 'skipped' | 'cancelled' | 'expired';
export interface Question {
  id: string; chatId: string; question: string; choices: string[]; allowFreeText: boolean;
  status: QuestionStatus; answer: string | null; createdAt: number; deadline: number | null; settledAt: number | null;
}

// Chats and what hangs off one: tasks, folders, queued input, ask_user questions, rewind and delete.
// One area of the Store; see index.js.

export class ChatStore {
  declare db: DatabaseSync;
  declare messages: MessageStore;
  declare automations: AutomationStore;
  declare documents: DocumentStore;
  declare embeddings: EmbeddingStore;

  constructor(db: DatabaseSync, deps: { messages: MessageStore; automations: AutomationStore; documents: DocumentStore; embeddings: EmbeddingStore }) {
    this.db = db;
    Object.assign(this, deps);
  }

  listTasks(chatId: string): Task[] {
    return this.db.prepare('SELECT id, title, status, created_at, updated_at FROM tasks WHERE chat_id = ? ORDER BY created_at, rowid').all(chatId) as unknown as Task[];
  }

  /**
   * Task writes are stamped with the seq of the latest saved message: the
   * assistant message that made the call, which is saved before its tools run.
   * That seq lies inside the turn, after its question, so rewinding to the
   * question (or retrying its answer) undoes the write -- and it holds even if
   * the turn dies before saving anything more. See undoTasksFrom.
   */
  /**
   * The checklist as the user sees it: a task finished before the latest
   * question is done with and drops out, the rest stay. A finish is stamped
   * inside the turn that made it, so it compares against the question's seq
   * the same way a rewind does; a rewind that reopens a task shows it again.
   */
  visibleTasks(chatId: string): Task[] {
    return this.db.prepare(`
      SELECT id, title, status, created_at, updated_at FROM tasks t
      WHERE chat_id = ? AND (status != 'completed'
        OR COALESCE((SELECT MAX(seq) FROM task_changes c WHERE c.task_id = t.id), t.created_seq)
           >= COALESCE((SELECT MAX(seq) FROM messages m WHERE m.chat_id = t.chat_id AND m.role = 'user'), -1))
      ORDER BY created_at, rowid`).all(chatId) as unknown as Task[];
  }

  addTask(chatId: string, title: string): Task | undefined {
    const id = randomUUID();
    const now = Date.now();
    this.db.prepare('INSERT INTO tasks (id, chat_id, title, created_at, updated_at, created_seq) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, chatId, title, now, now, this.#stamp(chatId));
    return this.listTasks(chatId).find((task) => task.id === id);
  }

  updateTask(chatId: string, id: string, status: TaskStatus): Task | null | undefined {
    const prev = this.db.prepare('SELECT status FROM tasks WHERE chat_id = ? AND id = ?').get(chatId, id) as { status: TaskStatus } | undefined;
    if (!prev) return null;
    this.db.prepare('INSERT INTO task_changes (chat_id, task_id, seq, prev_status) VALUES (?, ?, ?, ?)')
      .run(chatId, id, this.#stamp(chatId), prev.status);
    this.db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE chat_id = ? AND id = ?')
      .run(status, Date.now(), chatId, id);
    return this.listTasks(chatId).find((task) => task.id === id);
  }

  #stamp(chatId: string) {
    return this.messages.nextSeq(chatId) - 1;
  }

  /** Undoes the checklist writes made from `seq` on: changes newest first, then the tasks added. */
  undoTasksFrom(chatId: string, seq: number): void {
    const changes = this.db.prepare(
      'SELECT rowid, task_id, prev_status FROM task_changes WHERE chat_id = ? AND seq >= ? ORDER BY rowid DESC'
    ).all(chatId, seq) as { rowid: number; task_id: string; prev_status: TaskStatus }[];
    const restore = this.db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE chat_id = ? AND id = ?');
    for (const c of changes) restore.run(c.prev_status, Date.now(), chatId, c.task_id);
    this.db.prepare('DELETE FROM task_changes WHERE chat_id = ? AND seq >= ?').run(chatId, seq);
    this.db.prepare('DELETE FROM tasks WHERE chat_id = ? AND created_seq >= ?').run(chatId, seq);
  }

  create({ id, title = 'New chat', createdAt = Date.now() }: { id?: string; title?: string; createdAt?: number } = {},
    userId: Scope = ALL_USERS): ChatRow | null {
    const chatId = id || randomUUID();
    this.db.prepare(
      'INSERT INTO chats (id, title, created_at, updated_at, user_id) VALUES (?, ?, ?, ?, ?)'
    ).run(chatId, title, createdAt, createdAt, ownerOf(userId));
    return this.byId(chatId);
  }

  claimUnowned(userId: string): void {
    this.db.prepare('UPDATE chats SET user_id = ? WHERE user_id IS NULL').run(userId);
    this.db.prepare('UPDATE folders SET user_id = ? WHERE user_id IS NULL').run(userId);
  }

  /** Every chat of one owner, oldest first: what a backup takes. */
  allFor(userId: Scope): ChatRow[] {
    const s = scope(userId);
    return this.db.prepare(`SELECT * FROM chats WHERE ${s.sql} ORDER BY created_at, rowid`).all(...s.params) as unknown as ChatRow[];
  }

  /** The tasks with the seq each was added at, which listTasks leaves out. */
  taskRecords(chatId: string): TaskRecord[] {
    return this.db.prepare('SELECT id, title, status, created_at, updated_at, created_seq FROM tasks WHERE chat_id = ? ORDER BY created_at, rowid')
      .all(chatId) as unknown as TaskRecord[];
  }

  /**
   * Writes a chat from a backup in one transaction: the row, its messages with
   * the tool output they point at, and its tasks. Nothing half-written is left
   * if any of it fails. The prompt-cache breakpoint is not carried over: it
   * named a cache on whatever server the chat came from.
   */
  restore(chat: RestoredChat, userId: Scope): ChatRow {
    const owner = ownerOf(userId);
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`INSERT INTO chats (id, title, created_at, updated_at, user_id, folder, tags_json, parent_id, fork_seq, epoch, window_seq, checkpoint_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(chat.id, chat.title, chat.createdAt, chat.updatedAt, owner, chat.folder, chat.tagsJson,
        chat.parentId, chat.forkSeq, chat.epoch, chat.windowSeq, chat.checkpointJson);
      for (const m of chat.messages) {
        const artifactId = m.artifact ? this.messages.restoreArtifact(chat.id, m.artifact, owner) : null;
        this.messages.restore(chat.id, m, artifactId);
      }
      const addTask = this.db.prepare('INSERT INTO tasks (id, chat_id, title, status, created_at, updated_at, created_seq) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const t of chat.tasks) addTask.run(randomUUID(), chat.id, t.title, t.status, t.createdAt, t.updatedAt, t.createdSeq);
      this.db.exec('COMMIT');
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
    return this.byId(chat.id)!;
  }

  /** Scoped lookup for anything reached from a request. See scope(). */
  get(id: string, userId: Scope): ChatRow | null {
    const s = scope(userId);
    return (this.db.prepare(`SELECT * FROM chats WHERE id = ? AND ${s.sql}`).get(id, ...s.params) as ChatRow | undefined) || null;
  }

  /** Unscoped lookup for internal plumbing that already holds a chat id it
   * got from a scoped path (the chat loop, compaction, automation runs). */
  byId(id: string): ChatRow | null {
    return (this.db.prepare('SELECT * FROM chats WHERE id = ?').get(id) as ChatRow | undefined) || null;
  }

  list(limit: number, userId: Scope): ChatListing[] {
    const s = scope(userId);
    return this.db.prepare(
      `SELECT id, title, updated_at, epoch, boundary_seq, folder, unread_at, parent_id, fork_seq FROM chats WHERE ${s.sql} ORDER BY updated_at DESC LIMIT ?`
    ).all(...s.params, limit) as unknown as ChatListing[];
  }

  /** Unscoped: an automation run, which already holds the chat it ran in. */
  markUnread(id: string, at = Date.now()): void {
    this.db.prepare('UPDATE chats SET unread_at = ? WHERE id = ?').run(at, id);
  }

  /** The owner has seen it. False when the chat is not theirs (or gone). */
  markRead(id: string, userId: Scope): boolean {
    const s = scope(userId);
    return this.db.prepare(`UPDATE chats SET unread_at = NULL WHERE id = ? AND ${s.sql}`).run(id, ...s.params).changes > 0;
  }

  organize(id: string, { folder = null, tags }: { folder?: unknown; tags?: unknown } = {}, userId: Scope): ChatRow | null {
    if (!this.get(id, userId)) return null;
    const clean = (items: unknown, max: number) => [...new Set((Array.isArray(items) ? items : [])
      .map((v) => String(v).trim().slice(0, max)).filter(Boolean))].slice(0, 10);
    const cleanFolder = folder == null ? null : String(folder).trim().slice(0, 40) || null;
    const tagsJson = tags === undefined ? null : JSON.stringify(clean(tags, 32));
    const result = this.db.prepare('UPDATE chats SET folder = ?, tags_json = COALESCE(?, tags_json) WHERE id = ?')
      .run(cleanFolder, tagsJson, id);
    return result.changes ? this.byId(id) : null;
  }

  /** Names only, sorted -- the create-then-move-chats-into-it workflow needs
   * to list folders even when nothing has been organized into them yet. */
  listFolders(userId: Scope): string[] {
    const s = scope(userId);
    return this.db.prepare(`SELECT name FROM folders WHERE ${s.sql}`).all(...s.params).map((r) => r.name as string).sort((a, b) => a.localeCompare(b));
  }

  /** The folders that have instructions of their own: name -> prompt. */
  folderPrompts(userId: Scope): Record<string, string> {
    const s = scope(userId);
    const rows = this.db.prepare(`SELECT name, prompt FROM folders WHERE prompt != '' AND ${s.sql}`).all(...s.params) as { name: string; prompt: string }[];
    return Object.fromEntries(rows.map((r) => [r.name, r.prompt]));
  }

  /** The instructions of the folder a chat is in, '' when it is in none or the folder has none. Unscoped: the chat
   * row already says whose folder it is. */
  folderPromptFor(chat: Pick<ChatRow, 'folder' | 'user_id'>): string {
    if (!chat.folder) return '';
    const row = this.db.prepare('SELECT prompt FROM folders WHERE name = ? AND user_id IS ?').get(chat.folder, chat.user_id) as { prompt: string } | undefined;
    return row?.prompt || '';
  }

  /**
   * Renames a folder and/or sets its instructions. A rename moves its chats
   * along, in the same transaction. 'missing' when there is no such folder,
   * 'taken' when the new name is another folder's.
   */
  updateFolder(name: string, { rename, prompt }: { rename?: string; prompt?: string }, userId: Scope): string | 'missing' | 'taken' {
    const owner = ownerOf(userId);
    const s = scope(owner);
    const has = (n: string) => Boolean(this.db.prepare(`SELECT 1 FROM folders WHERE name = ? AND ${s.sql}`).get(n, ...s.params));
    if (!has(name)) return 'missing';
    const to = rename === undefined ? name : rename.trim().slice(0, 40);
    if (!to) return 'missing';
    if (to !== name && has(to)) return 'taken';
    this.db.exec('BEGIN');
    try {
      if (prompt !== undefined) this.db.prepare(`UPDATE folders SET prompt = ? WHERE name = ? AND ${s.sql}`).run(prompt.trim().slice(0, 20000), name, ...s.params);
      if (to !== name) {
        this.db.prepare(`UPDATE folders SET name = ? WHERE name = ? AND ${s.sql}`).run(to, name, ...s.params);
        this.db.prepare(`UPDATE chats SET folder = ? WHERE folder = ? AND ${s.sql}`).run(to, name, ...s.params);
      }
      this.db.exec('COMMIT');
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
    return to;
  }

  /**
   * Makes `ids` the folder's chats: those join it (from wherever they were),
   * and any chat in it that is not listed leaves it for no folder. Chats that
   * are not the owner's are skipped. Neither move counts as activity, so the
   * list order stays. 'missing' when there is no such folder.
   */
  setFolderChats(name: string, ids: string[], userId: Scope): number | 'missing' {
    const owner = ownerOf(userId);
    const s = scope(owner);
    if (!this.db.prepare(`SELECT 1 FROM folders WHERE name = ? AND ${s.sql}`).get(name, ...s.params)) return 'missing';
    const keep = [...new Set(ids)];
    const marks = keep.map(() => '?').join(', ');
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`UPDATE chats SET folder = NULL WHERE folder = ? AND ${s.sql}${keep.length ? ` AND id NOT IN (${marks})` : ''}`)
        .run(name, ...s.params, ...keep);
      const moved = keep.length
        ? Number(this.db.prepare(`UPDATE chats SET folder = ? WHERE id IN (${marks}) AND ${s.sql}`).run(name, ...keep, ...s.params).changes)
        : 0;
      this.db.exec('COMMIT');
      return moved;
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }

  /** A new title, without counting as activity. Null when the chat is not theirs or the title is blank. */
  rename(id: string, title: unknown, userId: Scope): ChatRow | null {
    const clean = String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!clean || !this.get(id, userId)) return null;
    this.db.prepare('UPDATE chats SET title = ? WHERE id = ?').run(clean, id);
    return this.byId(id);
  }

  createFolder(name: unknown, userId: Scope): string | null {
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
  addQueued(chatId: string, { id, kind, content }: { id: unknown; kind: QueueKind; content: unknown }): boolean {
    return this.db.prepare(
      'INSERT OR IGNORE INTO queued_messages (id, chat_id, kind, content, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(String(id), chatId, kind, String(content), Date.now()).changes > 0;
  }

  /** A chat's queue, oldest first. */
  listQueued(chatId: string): (QueuedItem & { created_at: number })[] {
    return this.db.prepare(
      'SELECT id, kind, content, created_at FROM queued_messages WHERE chat_id = ? ORDER BY pos'
    ).all(chatId) as unknown as (QueuedItem & { created_at: number })[];
  }

  /**
   * Removes and returns queued items for delivery, oldest first: every item
   * of `kind`, or with `first` only the oldest item of any kind.
   */
  takeQueued(chatId: string, { kind = null, first = false }: { kind?: QueueKind | null; first?: boolean } = {}): QueuedItem[] {
    const rows = this.db.prepare(
      `SELECT pos, id, kind, content FROM queued_messages WHERE chat_id = ?${kind ? ' AND kind = ?' : ''} ORDER BY pos${first ? ' LIMIT 1' : ''}`
    ).all(...(kind ? [chatId, kind] : [chatId])) as unknown as (QueuedItem & { pos: number })[];
    const drop = this.db.prepare('DELETE FROM queued_messages WHERE pos = ?');
    for (const r of rows) drop.run(r.pos);
    return rows.map(({ id, kind: k, content }) => ({ id, kind: k, content }));
  }

  /** Withdraws one queued item before it is delivered. */
  deleteQueued(chatId: string, id: unknown): boolean {
    return this.db.prepare('DELETE FROM queued_messages WHERE chat_id = ? AND id = ?').run(chatId, String(id)).changes > 0;
  }

  /** Records a question as pending. `deadline` is epoch ms, or null for no timeout. */
  addQuestion(chatId: string, { id, question, choices = [], allowFreeText = true, deadline = null }:
    { id: string; question: string; choices?: string[]; allowFreeText?: boolean; deadline?: number | null }): void {
    this.db.prepare(
      'INSERT INTO questions (id, chat_id, question, choices_json, allow_free_text, created_at, deadline) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(String(id), chatId, question, JSON.stringify(choices), allowFreeText ? 1 : 0, Date.now(), deadline);
  }

  getQuestion(id: unknown): Question | undefined {
    const row = this.db.prepare('SELECT * FROM questions WHERE id = ?').get(String(id)) as {
      id: string; chat_id: string; question: string; choices_json: string; allow_free_text: number; status: QuestionStatus;
      answer: string | null; created_at: number; deadline: number | null; settled_at: number | null;
    } | undefined;
    return row && {
      id: row.id, chatId: row.chat_id, question: row.question, choices: (parseColumn(row.choices_json, 'array') ?? []).filter((c): c is string => typeof c === 'string'),
      allowFreeText: Boolean(row.allow_free_text), status: row.status, answer: row.answer,
      createdAt: row.created_at, deadline: row.deadline, settledAt: row.settled_at
    };
  }

  /**
   * Settles a pending question. True for the one caller that settled it;
   * false when it was already settled (or never existed).
   */
  settleQuestion(id: unknown, status: QuestionStatus, answer: string | null = null): boolean {
    return this.db.prepare(
      "UPDATE questions SET status = ?, answer = ?, settled_at = ? WHERE id = ? AND status = 'pending'"
    ).run(status, answer, Date.now(), String(id)).changes > 0;
  }

  /** Expires every pending question: at startup no run is left to answer one. */
  expireQuestions(): number {
    return this.db.prepare(
      "UPDATE questions SET status = 'expired', settled_at = ? WHERE status = 'pending'"
    ).run(Date.now()).changes as number;
  }

  truncateFrom(chatId: string, seq: number): number {
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
      // the very question being asked again. A checkpoint summarises what that
      // window cut off, so it goes too.
      if (chat && chat.window_seq >= seq) this.touch(chatId, { window_seq: -1, checkpoint_json: null });
      this.db.exec('COMMIT');
      return removed;
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }

  /**
   * The rows a question got in reply: everything after it up to the next
   * question. Null when `questionSeq` is not a question of this chat.
   */
  replyTo(chatId: string, questionSeq: number): MessageRow[] | null {
    const rows = this.messages.list(chatId);
    const at = rows.findIndex((r) => r.seq === questionSeq);
    if (at < 0 || rows[at].role !== 'user') return null;
    const next = rows.findIndex((r, i) => i > at && r.role === 'user');
    return rows.slice(at + 1, next < 0 ? rows.length : next);
  }

  /**
   * The answer a question finally got, as the transcript shows it: the last
   * row of its reply, when that is the model speaking with no call after it.
   * A reply that ended on a tool call (or an error) has none to edit.
   */
  answerTo(chatId: string, questionSeq: number): MessageRow | null {
    const last = this.replyTo(chatId, questionSeq)?.at(-1);
    return last && last.role === 'assistant' && !last.tool_calls_json && last.content?.trim() ? last : null;
  }

  /**
   * Branches a chat into a new one of the same owner: every message up to and
   * including `throughSeq`, with the tool output behind them. `withFiles`
   * also copies the documents and images those messages attached; without
   * them the fork's questions keep their text but not the files, and the
   * model is not told of documents it could not open. The fork is listed
   * under its original (parent_id). Null when the chat is not theirs.
   */
  fork(chatId: string, throughSeq: number, { userId, withFiles, passageSettings }: { userId: Scope; withFiles: boolean; passageSettings?: PassageSettings }):
    { chat: ChatRow; documentIds: string[] } | null {
    const src = this.get(chatId, userId);
    if (!src) return null;
    const rows = this.messages.list(chatId).filter((r) => r.seq <= throughSeq);
    const id = randomUUID();
    this.db.exec('BEGIN');
    try {
      this.create({ id, title: `${src.title} (fork)` }, userId);
      this.db.prepare('UPDATE chats SET parent_id = ?, fork_seq = ?, folder = ? WHERE id = ?').run(chatId, throughSeq, src.folder, id);
      // Tool rows point at artifacts by id; each gets its own copy in the fork.
      const artifacts = new Map<string, string | null>();
      for (const r of rows) {
        let artifactId: string | null = null;
        if (r.artifact_id) {
          if (!artifacts.has(r.artifact_id)) artifacts.set(r.artifact_id, this.messages.copyArtifact(r.artifact_id, chatId, id));
          artifactId = artifacts.get(r.artifact_id) ?? null;
        }
        const content = r.role === 'user' && !withFiles && r.content != null ? splitAttachmentNotes(r.content).text : r.content;
        this.messages.copyInto(id, r, { content, images: withFiles ? r.images_json : null, artifactId });
      }
      this.db.exec('COMMIT');
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }

    const copied = new Map<string, { id: string; filename: string; char_len: number }>();
    if (withFiles) {
      // Documents copy in transactions of their own, so a failure here takes
      // the half-made fork away rather than leave it pointing at the original's.
      try {
        for (const r of rows) {
          if (r.role !== 'user') continue;
          const { text, ids } = splitAttachmentNotes(r.content);
          if (!ids.length) continue;
          for (const old of ids) {
            if (copied.has(old)) continue;
            const doc = this.documents.copyToChat(old, id, userId, passageSettings);
            if (doc) copied.set(old, doc);
          }
          // The notes name the fork's own copies, so read_document opens those.
          this.messages.setContent(id, r.seq, text + ids.filter((i) => copied.has(i)).map((i) => attachmentNote(copied.get(i)!)).join(''));
        }
      } catch (err) { this.delete(id, userId); throw err; }
    }
    return { chat: this.byId(id)!, documentIds: [...copied.values()].map((d) => d.id) };
  }

  /** Rewrites a question's answer in place. False when it has none. */
  editAnswer(chatId: string, questionSeq: number, content: string): boolean {
    const answer = this.answerTo(chatId, questionSeq);
    if (!answer) return false;
    this.db.exec('BEGIN');
    try {
      this.messages.setContent(chatId, answer.seq, content);
      // The model is resent the edited text from now on. A cache breakpoint
      // pinned at or past it no longer matches what is sent; a checkpoint that
      // summarised it describes the old text.
      const chat = this.byId(chatId);
      if (chat && chat.boundary_seq >= answer.seq) this.touch(chatId, { boundary_seq: -1 });
      if (chat && chat.window_seq > answer.seq) this.touch(chatId, { window_seq: -1, checkpoint_json: null });
      this.db.exec('COMMIT');
      return true;
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }

  delete(id: string, userId: Scope): boolean {
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

  touch(id: string, patch: ChatPatch = {}): void {
    const sets = ['updated_at = ?'];
    const vals: SQLInputValue[] = [Date.now()];
    for (const key of ['title', 'epoch', 'boundary_seq', 'window_seq', 'checkpoint_json'] as const) {
      if (patch[key] !== undefined) { sets.push(`${key} = ?`); vals.push(patch[key]); }
    }
    vals.push(id);
    this.db.prepare(`UPDATE chats SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
}
