import { mergeAttribution } from './attribution.js';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID } from 'node:crypto';
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
-- Optional auth/RBAC (config authMode 'single'/'multiuser'). Unused and
-- empty when authMode is 'none', the default -- these tables cost nothing
-- to have around.
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE,
  google_sub    TEXT UNIQUE,
  password_hash TEXT,
  role          TEXT NOT NULL DEFAULT 'user',
  status        TEXT NOT NULL DEFAULT 'pending',
  created_at    INTEGER NOT NULL,
  approved_at   INTEGER,
  last_login_at INTEGER
);

-- Session tokens are stored hashed (sha256), never the raw cookie value, the
-- same principle as password_hash above.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- One-time migration flags (e.g. backfilling user_id onto pre-auth rows),
-- so a backfill never accidentally reruns and clobbers real ownership later.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS chats (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  epoch        INTEGER NOT NULL DEFAULT 0,
  boundary_seq INTEGER NOT NULL DEFAULT -1,
  folder       TEXT,
  tags_json    TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_chat ON tasks(chat_id, created_at);

CREATE TABLE IF NOT EXISTS automations (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  cron TEXT NOT NULL,
  timezone TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_run_at INTEGER,
  last_run_at INTEGER,
  last_status TEXT,
  last_result TEXT,
  source TEXT NOT NULL DEFAULT 'user',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS automations_due ON automations(enabled, next_run_at);
CREATE INDEX IF NOT EXISTS automations_user ON automations(user_id, updated_at);

CREATE TABLE IF NOT EXISTS automation_runs (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  scheduled_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  status TEXT NOT NULL,
  trigger_type TEXT NOT NULL DEFAULT 'schedule',
  result TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS automation_runs_recent ON automation_runs(automation_id, scheduled_at DESC);

-- Folders exist as their own rows so an empty one -- created but nothing
-- moved into it yet -- still shows up in the sidebar. A chat's folder
-- column stores the name directly rather than an id: simple, and it already
-- had to tolerate a folder that was renamed or removed out from under it.
CREATE TABLE IF NOT EXISTS folders (
  name       TEXT NOT NULL,
  user_id    TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(name, user_id)
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
  usage_json             TEXT,
  model                  TEXT,
  created_at             INTEGER,
  images_json            TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS messages_chat_seq ON messages(chat_id, seq);

-- Input sent while a turn was still running: 'steer' is delivered at the next
-- safe boundary inside the run, 'followup' once it would otherwise go idle.
-- Kept here rather than in the run so a reload or restart cannot lose one;
-- the id comes from the client, so a retried submit cannot add it twice.
CREATE TABLE IF NOT EXISTS queued_messages (
  pos        INTEGER PRIMARY KEY AUTOINCREMENT,
  id         TEXT NOT NULL UNIQUE,
  chat_id    TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('steer', 'followup')),
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- A question the model put to the user mid-run (ask_user). One row per
-- question, settled exactly once: the UPDATE that settles it only matches a
-- pending row, so a duplicate submit, a late answer or a timeout racing an
-- answer each find it already settled. A run lives in memory, so a row still
-- pending when the server starts is expired, not restored.
CREATE TABLE IF NOT EXISTS questions (
  id              TEXT PRIMARY KEY,
  chat_id         TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  question        TEXT NOT NULL,
  choices_json    TEXT NOT NULL DEFAULT '[]',
  allow_free_text INTEGER NOT NULL DEFAULT 1,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'answered', 'timeout', 'skipped', 'cancelled', 'expired')),
  answer          TEXT,
  created_at      INTEGER NOT NULL,
  deadline        INTEGER,
  settled_at      INTEGER
);
CREATE INDEX IF NOT EXISTS questions_pending ON questions(chat_id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS artifacts (
  id         TEXT PRIMARY KEY,
  chat_id    TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  tool_name  TEXT NOT NULL,
  args_json  TEXT,
  content    TEXT NOT NULL,
  char_len   INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- Attached documents. Full text is kept whole here, like artifacts.content.
--
-- Retrieval is small-to-big: a document is split into PASSAGES (what
-- read_document returns, retrieval.passageSize characters each), and for
-- dense/hybrid search each passage is split again into CHUNKS sized to the
-- embedding model (what gets embedded). A query scores every chunk, each
-- passage takes its best chunk's score, and the model gets whole passages.
CREATE TABLE IF NOT EXISTS documents (
  id         TEXT PRIMARY KEY,
  chat_id    TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  filename   TEXT NOT NULL,
  mime       TEXT,
  char_len   INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  content    TEXT NOT NULL
);

-- Passages live in FTS5 for BM25. FTS5 can't carry the doc id / passage
-- index itself, so a plain map table sits next to it, keyed by the same
-- rowid, the same split messages/messages_fts already uses.
CREATE TABLE IF NOT EXISTS document_passage_map (
  passage_rowid INTEGER PRIMARY KEY,
  doc_id        TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chat_id       TEXT NOT NULL,
  passage_idx   INTEGER NOT NULL,
  char_start    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS document_passage_map_doc ON document_passage_map(doc_id);

CREATE VIRTUAL TABLE IF NOT EXISTS document_passages USING fts5(
  body, tokenize='unicode61'
);

-- Dense retrieval (retrieval.mode 'dense' / 'hybrid'): the embedded chunks
-- of each passage, one float32 vector per chunk, per embedding model.
-- model_key names the model (and chunking), so switching re-embeds instead
-- of mixing incompatible vectors -- the rule TinyContext follows too.
CREATE TABLE IF NOT EXISTS document_chunks (
  passage_rowid INTEGER NOT NULL,
  doc_id        TEXT NOT NULL,
  model_key     TEXT NOT NULL,
  chunk         INTEGER NOT NULL,
  vec           BLOB NOT NULL,
  PRIMARY KEY (passage_rowid, model_key, chunk)
);
CREATE INDEX IF NOT EXISTS document_chunks_doc ON document_chunks(doc_id, model_key);

-- Full-text search over what was actually said, not how it got answered.
-- Reasoning and tool results are the "work" the transcript shows collapsed,
-- not the conversation, and are left out of the index by role alone -- a
-- tool result can be a page-sized scrape, and indexing it would mean every
-- search is mostly noise from things nobody typed or read. ('system' rows
-- would be indexed too, but none are ever persisted: the system prompt and
-- the per-round budget note are wire-only, appended in llm.js and never
-- written to the store.)
--
-- Role alone is not enough, though. Narration between tool calls -- "let me
-- check the PDF" -- is a real assistant message, indistinguishable by role
-- from the answer that ends the turn, and the UI itself treats it the same
-- way: addTurn() in app.js demotes it into the collapsed work the moment
-- anything follows it, under a "note" label, and only whatever is still
-- standing when the turn ends is shown as the answer. The index follows the
-- same rule. A message can't know its own fate at insert time -- more rounds
-- might still follow -- so every assistant row is indexed provisionally, and
-- the "supersede" trigger below retracts the one immediately before it the
-- moment a further assistant or tool row proves it was narration, not the
-- answer. Whatever is left indexed when the turn ends is, by construction,
-- exactly what the transcript ended up calling the answer. (A note is
-- visible in the index for the brief window before that -- moot in practice,
-- since a running chat is excluded from search results entirely regardless;
-- see isRunning in server.js.)
--
-- Deliberately NOT an external-content table: FTS5's external-content mode
-- expects to read the indexed columns back off the source table by name when
-- it needs to (a rebuild, an integrity-check), which only works when the
-- source table happens to have a same-named column -- ours doesn't, since
-- 'body' is a filtered, role-conditional projection of content, not a
-- column that exists anywhere. A plain FTS5 table stores its own copy of
-- that text instead: one extra copy of the visible transcript on disk, in
-- exchange for triggers that are ordinary INSERT/UPDATE/DELETE rather than
-- external-content's special 'delete' and 'rebuild' incantations.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  body,
  tokenize='unicode61'
);

-- Dropped and recreated every open rather than IF NOT EXISTS: a trigger by
-- this name may already exist from an earlier shape of this logic, and IF
-- NOT EXISTS would leave that older body (and whatever it left indexed) in
-- place silently. The table itself does not need this -- its shape hasn't
-- changed -- only what gets written into it has.
DROP TRIGGER IF EXISTS messages_fts_ai;
DROP TRIGGER IF EXISTS messages_fts_supersede;
DROP TRIGGER IF EXISTS messages_fts_ad;
DROP TRIGGER IF EXISTS messages_fts_au;

CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages
WHEN new.role IN ('user', 'assistant', 'system') BEGIN
  INSERT INTO messages_fts(rowid, body) VALUES (new.id, coalesce(new.content, ''));
END;
-- The row immediately before this one, in the same chat, is retracted from
-- the index if it was an assistant row -- something else in the same turn
-- just followed it, so it was narration, not the answer. A 'user' row never
-- fires this (a new question ends the previous turn, it doesn't continue
-- it), so the trigger cannot retract an answer that genuinely stood alone.
CREATE TRIGGER messages_fts_supersede AFTER INSERT ON messages
WHEN new.role IN ('assistant', 'tool') BEGIN
  DELETE FROM messages_fts WHERE rowid = (
    SELECT id FROM messages WHERE chat_id = new.chat_id AND seq = new.seq - 1 AND role = 'assistant'
  );
END;
CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
  DELETE FROM messages_fts WHERE rowid = old.id;
END;
CREATE TRIGGER messages_fts_au AFTER UPDATE ON messages BEGIN
  DELETE FROM messages_fts WHERE rowid = new.id;
  INSERT INTO messages_fts(rowid, body)
    SELECT new.id, coalesce(new.content, '') WHERE new.role IN ('user', 'assistant', 'system');
END;
`;

/**
 * The bulk form of the supersede trigger above, for correcting whatever an
 * earlier shape of these triggers already left indexed: any assistant row
 * immediately followed, in the same chat, by another assistant or tool row.
 */
const SUPERSEDE_CLEANUP = `
  DELETE FROM messages_fts WHERE rowid IN (
    SELECT m.id FROM messages m
    JOIN messages nxt ON nxt.chat_id = m.chat_id AND nxt.seq = m.seq + 1
    WHERE m.role = 'assistant' AND nxt.role IN ('assistant', 'tool')
  )
`;

/**
 * Turns free text from a search box into an FTS5 MATCH expression that cannot
 * fail to parse. FTS5's own query grammar has ANDs, ORs, dashes, colons and
 * parens in it, and a search box is not a query language -- a user typing
 * "what's tuition cost?" should search for those words, not hit a syntax
 * error. Quoting every token as its own phrase turns that grammar off entirely
 * and leaves only AND-of-words, plus a trailing "*" on the last token so a
 * query still narrows results while it is being typed rather than only once
 * a whole word is finished.
 */
function ftsQuery(raw, { any = false } = {}) {
  const tokens = String(raw ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 12);
  if (!tokens.length) return '';
  const esc = (t) => t.replace(/"/g, '""');
  return tokens
    .map((t, i) => (i === tokens.length - 1 ? `"${esc(t)}"*` : `"${esc(t)}"`))
    .join(any ? ' OR ' : ' ');
}

/**
 * Adds a column if it isn't already there. `CREATE TABLE IF NOT EXISTS` is a
 * no-op against a live table, so a column added to a table's shape after
 * installs already exist has to be self-repaired this way instead -- the
 * same pattern `model`/`created_at`/`images_json` already use below for
 * `messages`. `ALTER TABLE ADD COLUMN` itself has no IF NOT EXISTS form.
 */
/**
 * Every read of user-owned rows names whose rows it wants. There is no
 * default: `undefined` throws, so a caller that forgot to pass the
 * authenticated user fails loudly instead of silently seeing everyone's data.
 *   string     that user's rows
 *   null       rows with no owner (legacy / pre-auth rows)
 *   ALL_USERS  no filter -- authMode 'none', admin views, internal plumbing
 */
export const ALL_USERS = Symbol('all-users');

/** Default passage split: characters per passage, and how much neighbours overlap. */
export const PASSAGE_SIZE = 1800;
export const PASSAGE_OVERLAP = 200;

/**
 * Bumped whenever the constructor's migrations change the shape of the
 * database. Stored in SQLite's user_version, so deployments can see where a
 * file stands and run migrations deliberately (`tinywebui migrate`).
 */
export const SCHEMA_VERSION = 7;

/** Thrown when a database is behind and migrating was not allowed. */
export class MigrationRequiredError extends Error {}

function scope(userId, col = 'user_id') {
  if (userId === ALL_USERS) return { sql: '1=1', params: [] };
  if (userId === null) return { sql: `${col} IS NULL`, params: [] };
  if (typeof userId === 'string' && userId) return { sql: `${col} = ?`, params: [userId] };
  throw new TypeError('store: a user scope is required (pass a user id, null, or ALL_USERS)');
}

/** The owner to write onto a new row: ALL_USERS (no auth) owns as null. */
function ownerOf(userId) {
  if (userId === ALL_USERS || userId === null || userId === undefined) return null;
  return String(userId);
}

function ensureColumn(db, table, col, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
}

export class Store {
  /**
   * `migrate: false` refuses to touch an existing database that is behind
   * SCHEMA_VERSION instead of upgrading it on open; a brand-new file is
   * always created at the current version.
   */
  constructor(path, { migrate = true } = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    const found = this.db.prepare('PRAGMA user_version').get().user_version;
    const fresh = !this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chats'").get();
    if (!fresh && found > SCHEMA_VERSION) {
      this.db.close();
      throw new MigrationRequiredError(`database is at schema ${found}, newer than this TinyWebUI (${SCHEMA_VERSION}); upgrade TinyWebUI`);
    }
    if (!fresh && found < SCHEMA_VERSION && !migrate) {
      this.db.close();
      throw new MigrationRequiredError(`database is at schema ${found}, needs ${SCHEMA_VERSION}: run \`tinywebui migrate\``);
    }
    this.migratedFrom = fresh ? null : found;
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    if (!fresh) this.#renameToPassages();
    this.db.exec(SCHEMA);
    // Nullable everywhere: unused (null) when auth is off, the exact behavior
    // installs already have; set only once per-user scoping is opted into.
    ensureColumn(this.db, 'chats', 'user_id', 'TEXT');
    ensureColumn(this.db, 'chats', 'folder', 'TEXT');
    ensureColumn(this.db, 'chats', 'tags_json', "TEXT NOT NULL DEFAULT '[]'");
    // First message the model still sees once the hard window has moved; -1
    // until it ever has. See planWindow in compact.js.
    ensureColumn(this.db, 'chats', 'window_seq', 'INTEGER NOT NULL DEFAULT -1');
    // Set once an epoch has taken a message's images off the wire; the images
    // themselves stay in images_json for the transcript.
    ensureColumn(this.db, 'messages', 'images_dropped', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn(this.db, 'documents', 'user_id', 'TEXT');
    // The passage split a document was stored with; NULL means the original
    // 1800/200, from before it was configurable.
    ensureColumn(this.db, 'documents', 'passage_size', 'INTEGER');
    ensureColumn(this.db, 'documents', 'passage_overlap', 'INTEGER');
    ensureColumn(this.db, 'artifacts', 'user_id', 'TEXT');
    ensureColumn(this.db, 'automation_runs', 'trigger_type', "TEXT NOT NULL DEFAULT 'schedule'");
    // Trusted-header auth: the gateway's immutable subject. Email and name are
    // metadata reconciled from the gateway; external_id decides who owns what.
    ensureColumn(this.db, 'users', 'external_id', 'TEXT');
    ensureColumn(this.db, 'users', 'name', 'TEXT');
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_external_id ON users(external_id)');
    // Per-user preferences (tier 3): harmless choices like which allowed
    // model to use. Deployment settings never live here.
    this.db.exec(`CREATE TABLE IF NOT EXISTS user_prefs (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key     TEXT NOT NULL,
      value   TEXT,
      PRIMARY KEY (user_id, key)
    )`);
    // `messages` may already exist from before these columns did --
    // CREATE TABLE IF NOT EXISTS above is a no-op against a live table, so
    // they're added here instead, self-repairing like the FTS backfill below.
    const cols = this.db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
    if (!cols.includes('model')) this.db.exec('ALTER TABLE messages ADD COLUMN model TEXT');
    if (!cols.includes('created_at')) this.db.exec('ALTER TABLE messages ADD COLUMN created_at INTEGER');
    if (!cols.includes('images_json')) this.db.exec('ALTER TABLE messages ADD COLUMN images_json TEXT');
    this.db.exec('CREATE INDEX IF NOT EXISTS messages_usage_ts ON messages(created_at) WHERE usage_json IS NOT NULL');
    // A tool row, or an assistant note later superseded within its own turn,
    // indexed under an earlier shape of the triggers above is corrected on
    // open rather than left to linger -- the triggers alone only ever
    // prevent NEW drift, not clean up old drift.
    this.db.exec(`
      DELETE FROM messages_fts WHERE rowid IN (
        SELECT id FROM messages WHERE role NOT IN ('user', 'assistant', 'system')
      )
    `);
    this.db.exec(SUPERSEDE_CLEANUP);
    // The triggers keep the index in step with every write from here on, but
    // they cannot backfill history that predates them -- a database from
    // before search existed opens with a `messages_fts` that is real but
    // empty for rows that should be in it. A count mismatch, restricted to
    // the roles that belong in the index, is also what any other divergence
    // would look like, so this doubles as self-repair: whatever is missing
    // is added, nothing already correct is touched.
    const { m, f } = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM messages WHERE role IN ('user', 'assistant', 'system')) AS m,
        (SELECT COUNT(*) FROM messages_fts) AS f
    `).get();
    if (m !== f) {
      this.db.exec(`
        INSERT INTO messages_fts(rowid, body)
        SELECT id, coalesce(content, '')
        FROM messages
        WHERE role IN ('user', 'assistant', 'system')
          AND id NOT IN (SELECT rowid FROM messages_fts)
      `);
    }
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  /**
   * Schema 4 renamed "chunks" to what they are: document_chunks (FTS) and
   * its map became document_passages / document_passage_map, and the name
   * document_chunks now holds embedded chunks. Must run before SCHEMA, which
   * would otherwise see the old FTS table under the new chunk table's name.
   */
  #renameToPassages() {
    const has = (name) => Boolean(this.db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(name));
    if (has('document_chunk_map')) {
      this.db.exec('BEGIN');
      try {
        this.db.exec('ALTER TABLE document_chunks RENAME TO document_passages');
        this.db.exec('ALTER TABLE document_chunk_map RENAME TO document_passage_map');
        this.db.exec('ALTER TABLE document_passage_map RENAME COLUMN chunk_rowid TO passage_rowid');
        this.db.exec('ALTER TABLE document_passage_map RENAME COLUMN chunk_idx TO passage_idx');
        this.db.exec('DROP INDEX IF EXISTS document_chunk_map_doc');
        this.db.exec('COMMIT');
      } catch (err) { this.db.exec('ROLLBACK'); throw err; }
    }
    // Vectors from the unreleased schema 3 layout: recomputed by the backfill.
    this.db.exec('DROP TABLE IF EXISTS document_chunk_embeddings');
  }

  schemaVersion() {
    return this.db.prepare('PRAGMA user_version').get().user_version;
  }

  /** Cheap liveness probe of the database, for /readyz. */
  ping() {
    return this.db.prepare('SELECT 1 AS ok').get().ok === 1;
  }

  close() {
    try { this.db.close(); } catch { /* already gone */ }
  }

  /* ---------- chats ---------- */

  listTasks(chatId) {
    return this.db.prepare('SELECT id, title, status, created_at, updated_at FROM tasks WHERE chat_id = ? ORDER BY created_at, rowid').all(chatId);
  }

  addTask(chatId, title) {
    const id = randomUUID();
    const now = Date.now();
    this.db.prepare('INSERT INTO tasks (id, chat_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, chatId, title, now, now);
    return this.listTasks(chatId).find((task) => task.id === id);
  }

  updateTask(chatId, id, status) {
    const changed = this.db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE chat_id = ? AND id = ?')
      .run(status, Date.now(), chatId, id).changes;
    return changed ? this.listTasks(chatId).find((task) => task.id === id) : null;
  }

  createChat({ id, title = 'New chat', createdAt = Date.now() } = {}, userId = ALL_USERS) {
    const chatId = id || randomUUID();
    this.db.prepare(
      'INSERT INTO chats (id, title, created_at, updated_at, user_id) VALUES (?, ?, ?, ?, ?)'
    ).run(chatId, title, createdAt, createdAt, ownerOf(userId));
    return this.chatById(chatId);
  }

  /** Scoped lookup for anything reached from a request. See scope(). */
  getChat(id, userId) {
    const s = scope(userId);
    return this.db.prepare(`SELECT * FROM chats WHERE id = ? AND ${s.sql}`).get(id, ...s.params) || null;
  }

  /** Unscoped lookup for internal plumbing that already holds a chat id it
   * got from a scoped path (the chat loop, compaction, automation runs). */
  chatById(id) {
    return this.db.prepare('SELECT * FROM chats WHERE id = ?').get(id) || null;
  }

  listChats(limit, userId) {
    const s = scope(userId);
    return this.db.prepare(
      `SELECT id, title, updated_at, epoch, boundary_seq, folder FROM chats WHERE ${s.sql} ORDER BY updated_at DESC LIMIT ?`
    ).all(...s.params, limit);
  }

  organizeChat(id, { folder = null, tags } = {}, userId) {
    if (!this.getChat(id, userId)) return null;
    const clean = (items, max) => [...new Set((Array.isArray(items) ? items : [])
      .map((v) => String(v).trim().slice(0, max)).filter(Boolean))].slice(0, 10);
    const cleanFolder = folder == null ? null : String(folder).trim().slice(0, 40) || null;
    const tagsJson = tags === undefined ? null : JSON.stringify(clean(tags, 32));
    const result = this.db.prepare('UPDATE chats SET folder = ?, tags_json = COALESCE(?, tags_json) WHERE id = ?')
      .run(cleanFolder, tagsJson, id);
    return result.changes ? this.chatById(id) : null;
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
    const removed = this.db
      .prepare('DELETE FROM messages WHERE chat_id = ? AND seq >= ?')
      .run(chatId, seq).changes;
    // A frozen compaction boundary inside the cut no longer describes anything,
    // so the pinned cache breakpoint it drives has to go with it.
    const chat = this.chatById(chatId);
    if (chat && chat.boundary_seq >= seq) this.touchChat(chatId, { boundary_seq: -1 });
    // Same for the hard window: a cut at or past the rewind point would hide
    // the very question being asked again.
    if (chat && chat.window_seq >= seq) this.touchChat(chatId, { window_seq: -1 });
    return removed;
  }

  deleteChat(id, userId) {
    if (!this.getChat(id, userId)) return false;
    this.db.prepare('DELETE FROM automations WHERE chat_id = ?').run(id);
    this.db.prepare('DELETE FROM messages WHERE chat_id = ?').run(id);
    this.db.prepare('DELETE FROM queued_messages WHERE chat_id = ?').run(id);
    this.db.prepare('DELETE FROM questions WHERE chat_id = ?').run(id);
    this.db.prepare('DELETE FROM artifacts WHERE chat_id = ?').run(id);
    // FTS5 has no foreign keys of its own, so its rows are dropped by rowid
    // before the map (and then the documents) that name them go with the chat.
    this.db.prepare(`
      DELETE FROM document_passages WHERE rowid IN (
        SELECT passage_rowid FROM document_passage_map WHERE chat_id = ?
      )
    `).run(id);
    this.db.prepare(`DELETE FROM document_chunks WHERE doc_id IN (
      SELECT id FROM documents WHERE chat_id = ?
    )`).run(id);
    this.db.prepare('DELETE FROM document_passage_map WHERE chat_id = ?').run(id);
    this.db.prepare('DELETE FROM documents WHERE chat_id = ?').run(id);
    this.db.prepare('DELETE FROM chats WHERE id = ?').run(id);
    return true;
  }

  /* ---------- automations ---------- */

  listAutomations(userId) {
    const s = scope(userId, 'a.user_id');
    return this.db.prepare(`SELECT a.*, c.title AS chat_title FROM automations a JOIN chats c ON c.id=a.chat_id
      WHERE ${s.sql} ORDER BY a.updated_at DESC`).all(...s.params).map(automationView);
  }

  listAllAutomations() {
    return this.db.prepare(`SELECT a.*, c.title AS chat_title FROM automations a JOIN chats c ON c.id=a.chat_id
      ORDER BY a.updated_at DESC`).all().map(automationView);
  }

  getAutomation(id, userId) {
    const s = scope(userId, 'a.user_id');
    const row = this.db.prepare(`SELECT a.*, c.title AS chat_title FROM automations a JOIN chats c ON c.id=a.chat_id
      WHERE a.id=? AND ${s.sql}`).get(id, ...s.params);
    return row ? automationView(row) : null;
  }

  createAutomation(data, userId) {
    scope(userId);
    const id = randomBytes(12).toString('hex');
    const now = Date.now();
    this.db.prepare(`INSERT INTO automations
      (id,user_id,chat_id,name,prompt,cron,timezone,enabled,next_run_at,source,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,ownerOf(userId),data.chatId,data.name,data.prompt,data.cron,data.timezone,
      data.enabled === false ? 0 : 1,data.nextRunAt,data.source || 'user',now,now);
    return this.getAutomation(id,userId);
  }

  updateAutomation(id, patch, userId) {
    const current = this.getAutomation(id,userId);
    if (!current) return null;
    const fields = { chatId:'chat_id', name:'name', prompt:'prompt', cron:'cron', timezone:'timezone', enabled:'enabled', nextRunAt:'next_run_at', lastRunAt:'last_run_at', lastStatus:'last_status', lastResult:'last_result' };
    const sets = ['updated_at=?'];
    const values = [Date.now()];
    for (const [key,col] of Object.entries(fields)) if (patch[key] !== undefined) {
      sets.push(`${col}=?`); values.push(key === 'enabled' ? (patch[key] ? 1 : 0) : patch[key]);
    }
    values.push(id);
    this.db.prepare(`UPDATE automations SET ${sets.join(',')} WHERE id=?`).run(...values);
    return this.getAutomation(id,userId);
  }

  deleteAutomation(id, userId) {
    const s = scope(userId);
    return this.db.prepare(`DELETE FROM automations WHERE id=? AND ${s.sql}`).run(id, ...s.params).changes > 0;
  }

  dueAutomations(now = Date.now()) {
    return this.db.prepare(`SELECT a.*, c.title AS chat_title FROM automations a JOIN chats c ON c.id=a.chat_id
      WHERE a.enabled=1 AND a.next_run_at<=? ORDER BY a.next_run_at`).all(now).map(automationView);
  }

  addAutomationRun(automationId, scheduledAt, status = 'queued', triggerType = 'schedule') {
    const id = randomBytes(12).toString('hex');
    this.db.prepare(`INSERT INTO automation_runs(id,automation_id,scheduled_at,status,trigger_type) VALUES(?,?,?,?,?)`)
      .run(id,automationId,scheduledAt,status,triggerType);
    return id;
  }

  updateAutomationRun(id, patch) {
    const fields = { status:'status', startedAt:'started_at', finishedAt:'finished_at', result:'result', error:'error' };
    const sets = []; const values = [];
    for (const [key,col] of Object.entries(fields)) if (patch[key] !== undefined) { sets.push(`${col}=?`); values.push(patch[key]); }
    if (sets.length) this.db.prepare(`UPDATE automation_runs SET ${sets.join(',')} WHERE id=?`).run(...values,id);
    const row = this.db.prepare('SELECT * FROM automation_runs WHERE id=?').get(id);
    const owner = this.db.prepare('SELECT user_id FROM automations WHERE id=?').get(row?.automation_id)?.user_id ?? null;
    if (row) this.updateAutomation(row.automation_id, {
      lastRunAt: row.started_at || row.scheduled_at, lastStatus: row.status,
      ...(row.result !== null ? { lastResult: row.result.slice(0, 4000) } : {})
    }, owner);
  }

  listAutomationRuns(automationId, userId, limit = 10) {
    const owned = this.getAutomation(automationId,userId);
    if (!owned) return null;
    return this.db.prepare('SELECT id,scheduled_at,started_at,finished_at,status,trigger_type,result,error FROM automation_runs WHERE automation_id=? ORDER BY scheduled_at DESC LIMIT ?')
      .all(automationId,Math.min(50,Math.max(1,limit)));
  }

  recoverAutomationRuns(now = Date.now()) {
    const rows = this.db.prepare("SELECT id FROM automation_runs WHERE status IN ('queued','running')").all();
    for (const row of rows) this.updateAutomationRun(row.id, {
      status: 'failed', finishedAt: now, error: 'Server restarted during this run.'
    });
  }

  touchChat(id, patch = {}) {
    const sets = ['updated_at = ?'];
    const vals = [Date.now()];
    for (const key of ['title', 'epoch', 'boundary_seq', 'window_seq']) {
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
         reasoning, reasoning_details_json, artifact_id, stub_text, usage_json,
         model, created_at, images_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      msg.images ? JSON.stringify(msg.images) : null
    );
    return seq;
  }

  updateMessageUsage(chatId, seq, usage) {
    this.db.prepare('UPDATE messages SET usage_json = ? WHERE chat_id = ? AND seq = ?')
      .run(JSON.stringify(usage), chatId, seq);
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

  /** Takes a message's images off the wire at an epoch; the transcript keeps them. */
  dropImages(messageId) {
    this.db.prepare('UPDATE messages SET images_dropped = 1 WHERE id = ?').run(messageId);
  }

  /**
   * Rolls up token usage across every assistant round that has it, bucketed
   * by local calendar day ('YYYY-MM-DD', via SQLite's julianday/strftime on
   * created_at) and by model. Buckets are computed in SQL rather than in JS
   * so a year of history doesn't have to be pulled across just to summarize
   * it. Field-name variance across providers (prompt_tokens vs input_tokens,
   * the several cache-token spellings) is normalized here the same way
   * transcript.js's tally() does client-side for a single round.
   *
   * Rows predating model/timestamp tracking have neither column set and land
   * in an 'unknown' day bucket instead of being dropped, so their tokens
   * still show up here the same way their cost already does in
   * usageStatistics() below.
   */
  usageRollup(userId) {
    const s = scope(userId, 'c.user_id');
    const rows = this.db.prepare(`
      SELECT CASE WHEN m.created_at IS NOT NULL
               THEN strftime('%Y-%m-%d', m.created_at / 1000, 'unixepoch')
               ELSE 'unknown' END AS day,
             m.model, m.usage_json
      FROM messages m JOIN chats c ON c.id=m.chat_id
      WHERE m.usage_json IS NOT NULL AND ${s.sql}
    `).all(...s.params);

    const byDay = new Map();
    for (const row of rows) {
      let u;
      try { u = JSON.parse(row.usage_json); } catch { continue; }
      const inTok = u.prompt_tokens ?? u.input_tokens ?? 0;
      const outTok = u.completion_tokens ?? u.output_tokens ?? 0;
      const cached = u.prompt_tokens_details?.cached_tokens
        ?? u.cache_read_input_tokens
        ?? u.cached_tokens
        ?? 0;
      const model = row.model || u.model || 'unknown';

      const cost = u.cost != null && Number.isFinite(Number(u.cost)) ? Number(u.cost) : null;
      if (!byDay.has(row.day)) byDay.set(row.day, { day: row.day, in: 0, out: 0, cached: 0, models: new Map() });
      const d = byDay.get(row.day);
      d.in += inTok; d.out += outTok; d.cached += cached;

      if (!d.models.has(model)) d.models.set(model, { model, in: 0, out: 0, cached: 0 });
      const m = d.models.get(model);
      m.in += inTok; m.out += outTok; m.cached += cached;
      m.attribution = mergeAttribution(m.attribution, u.attribution);
      m.requests = (m.requests || 0) + 1;
      if (cost !== null) {
        d.cost = (d.cost || 0) + cost;
        m.cost = (m.cost || 0) + cost;
        d.pricedRounds = (d.pricedRounds || 0) + 1;
        m.pricedRounds = (m.pricedRounds || 0) + 1;
      }
    }

    return [...byDay.values()]
      .map((d) => ({ ...d, models: [...d.models.values()] }))
      .sort((a, b) => a.day.localeCompare(b.day));
  }

  usageStatistics(userId) {
    const s = scope(userId, 'c.user_id');
    const rows = this.db.prepare(`SELECT m.chat_id,m.seq,m.role,m.content,m.tool_calls_json,m.model,m.usage_json
      FROM messages m JOIN chats c ON c.id=m.chat_id WHERE ${s.sql} ORDER BY m.chat_id,m.seq`).all(...s.params);
    const models = new Map();
    const tools = new Map();
    const summary = { rounds: 0, pricedRounds: 0, reportedCost: 0, completedAnswers: 0,
      pricedAnswers: 0, answerCostTotal: 0, answerTokens: 0, tokenAnswers: 0, toolCalls: 0 };
    let chatId = null;
    let answer = null;
    const finishAnswer = () => {
      if (!answer) return;
      if (answer.complete) {
        summary.completedAnswers++;
        summary.answerRoundsTotal = (summary.answerRoundsTotal || 0) + answer.rounds;
        if (answer.rounds && answer.pricedRounds === answer.rounds) {
          summary.pricedAnswers++;
          summary.answerCostTotal += answer.cost;
        }
        if (answer.rounds && answer.usageRounds === answer.rounds) { summary.tokenAnswers++; summary.answerTokens += answer.tokens; }
      }
    };
    for (const row of rows) {
      if (row.chat_id !== chatId) { finishAnswer(); chatId = row.chat_id; answer = null; }
      if (row.role === 'user') { finishAnswer(); answer = { rounds:0, usageRounds:0, pricedRounds:0, cost:0, tokens:0, complete:false }; continue; }
      if (row.role !== 'assistant') continue;
      summary.rounds++;
      if (answer) answer.rounds++;
      let usage = null;
      try { if (row.usage_json) usage = JSON.parse(row.usage_json); } catch { /* ignore malformed historic usage */ }
      const model = row.model || usage?.model || 'unknown';
      if (!models.has(model)) models.set(model, { model, in:0, out:0, cached:0, rounds:0, pricedRounds:0, cost:0 });
      const m = models.get(model);
      m.rounds++;
      if (row.tool_calls_json) {
        let calls = null;
        try { calls = JSON.parse(row.tool_calls_json); } catch { /* ignore malformed historic tool_calls */ }
        for (const call of calls || []) {
          const name = call?.function?.name;
          if (!name) continue;
          summary.toolCalls++;
          tools.set(name, (tools.get(name) || 0) + 1);
        }
      }
      if (usage) {
        const inTok = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
        const outTok = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
        const cached = Number(usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens ?? usage.cached_tokens ?? 0) || 0;
        const costValue = usage.cost ?? usage.total_cost;
        const cost = costValue !== undefined && costValue !== null && Number.isFinite(Number(costValue)) ? Number(costValue) : null;
        m.in += inTok; m.out += outTok; m.cached += cached;
        if (cost !== null) { m.cost += cost; m.pricedRounds++; summary.pricedRounds++; summary.reportedCost += cost; }
        if (answer) {
          if ((usage.prompt_tokens ?? usage.input_tokens) != null && (usage.completion_tokens ?? usage.output_tokens) != null) answer.usageRounds++;
          answer.tokens += inTok + outTok;
          if (cost !== null) { answer.pricedRounds++; answer.cost += cost; }
        }
      }
      if (!row.tool_calls_json && String(row.content || '').trim()) {
        if (answer) answer.complete = true;
      }
    }
    finishAnswer();
    return {
      rounds: summary.rounds,
      pricedRounds: summary.pricedRounds,
      unpricedRounds: summary.rounds - summary.pricedRounds,
      reportedCost: summary.pricedRounds ? summary.reportedCost : null,
      averageRoundCost: summary.pricedRounds ? summary.reportedCost / summary.pricedRounds : null,
      completedAnswers: summary.completedAnswers,
      pricedAnswers: summary.pricedAnswers,
      averageAnswerCost: summary.pricedAnswers ? summary.answerCostTotal / summary.pricedAnswers : null,
      averageAnswerTokens: summary.tokenAnswers ? summary.answerTokens / summary.tokenAnswers : null,
      averageRoundsPerAnswer: summary.completedAnswers ? summary.answerRoundsTotal / summary.completedAnswers : null,
      toolCalls: summary.toolCalls,
      models: [...models.values()].map((m) => ({ ...m, cost: m.pricedRounds ? m.cost : null }))
        .sort((a,b) => b.in + b.out - a.in - a.out),
      tools: [...tools.entries()].map(([name, calls]) => ({ name, calls }))
        .sort((a, b) => b.calls - a.calls)
    };
  }

  /* ---------- artifacts ---------- */

  addArtifact(chatId, { toolName, args, content }) {
    const id = randomBytes(12).toString('hex');
    this.db.prepare(`
      INSERT INTO artifacts (id, chat_id, tool_name, args_json, content, char_len, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, chatId, toolName, JSON.stringify(args ?? {}), content, content.length, Date.now());
    return id;
  }

  getArtifact(id, chatId) {
    return this.db.prepare('SELECT * FROM artifacts WHERE id = ? AND chat_id = ?').get(id, chatId) || null;
  }

  /* ---------- documents ---------- */

  /**
   * Splits text into overlapping passages -- the unit read_document returns.
   * Character-based on purpose: passages are for reading and BM25, and the
   * embedding side cuts its own model-sized chunks out of them. Breaks are
   * nudged onto a paragraph or line boundary when one is nearby, so a
   * passage doesn't open or close mid-sentence more than it has to.
   */
  static splitPassages(text, size = PASSAGE_SIZE, overlap = PASSAGE_OVERLAP) {
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

  #insertPassages(docId, chatId, content, size, overlap) {
    const passages = Store.splitPassages(content, size, overlap);
    const insertPassage = this.db.prepare('INSERT INTO document_passages (body) VALUES (?)');
    const insertMap = this.db.prepare(`
      INSERT INTO document_passage_map (passage_rowid, doc_id, chat_id, passage_idx, char_start)
      VALUES (?, ?, ?, ?, ?)
    `);
    passages.forEach((passage, idx) => {
      const { lastInsertRowid } = insertPassage.run(passage.text);
      insertMap.run(lastInsertRowid, docId, chatId, idx, passage.start);
    });
    return passages.length;
  }

  #deletePassages(docId) {
    this.db.prepare(`
      DELETE FROM document_passages WHERE rowid IN (
        SELECT passage_rowid FROM document_passage_map WHERE doc_id = ?
      )
    `).run(docId);
    this.db.prepare('DELETE FROM document_chunks WHERE doc_id = ?').run(docId);
    this.db.prepare('DELETE FROM document_passage_map WHERE doc_id = ?').run(docId);
  }

  addDocument(chatId, { filename, mime, content }, { passageSize = PASSAGE_SIZE, passageOverlap = PASSAGE_OVERLAP } = {}) {
    const id = randomBytes(12).toString('hex');
    const createdAt = Date.now();
    this.db.prepare(`
      INSERT INTO documents (id, chat_id, filename, mime, char_len, created_at, content, passage_size, passage_overlap)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, chatId, filename, mime ?? null, content.length, createdAt, content, passageSize, passageOverlap);
    const passages = this.#insertPassages(id, chatId, content, passageSize, passageOverlap);
    return { id, filename, mime: mime ?? null, char_len: content.length, created_at: createdAt, passages };
  }

  /** Documents split with other passage settings than these (NULL = the original 1800/200). */
  documentsWithOtherPassages(size, overlap) {
    return this.db.prepare(`
      SELECT id FROM documents
      WHERE COALESCE(passage_size, ${PASSAGE_SIZE}) != ? OR COALESCE(passage_overlap, ${PASSAGE_OVERLAP}) != ?
    `).all(size, overlap).map((r) => r.id);
  }

  /** Re-splits a stored document with new passage settings; its old vectors go with the old passages. */
  repassageDocument(docId, size, overlap) {
    const doc = this.db.prepare('SELECT id, chat_id, content FROM documents WHERE id = ?').get(docId);
    if (!doc) return 0;
    this.db.exec('BEGIN');
    try {
      this.#deletePassages(docId);
      const n = this.#insertPassages(doc.id, doc.chat_id, doc.content, size, overlap);
      this.db.prepare('UPDATE documents SET passage_size = ?, passage_overlap = ? WHERE id = ?').run(size, overlap, docId);
      this.db.exec('COMMIT');
      return n;
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }

  /** Scoped through the owning chat: a document is its chat's user's. */
  getDocument(id, userId) {
    const s = scope(userId, 'c.user_id');
    return this.db.prepare(
      `SELECT d.* FROM documents d JOIN chats c ON c.id = d.chat_id WHERE d.id = ? AND ${s.sql}`
    ).get(id, ...s.params) || null;
  }

  listDocuments(chatId) {
    return this.db.prepare(`
      SELECT id, filename, mime, char_len, created_at
      FROM documents WHERE chat_id = ? ORDER BY created_at ASC
    `).all(chatId);
  }

  /** Drops one document, its passages and their chunk vectors. The rest of the chat is untouched. */
  deleteDocument(id, userId) {
    if (!this.getDocument(id, userId)) return false;
    this.#deletePassages(id);
    return this.db.prepare('DELETE FROM documents WHERE id = ?').run(id).changes > 0;
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
  documentPassages(docId) {
    return this.db.prepare(`
      SELECT m.passage_rowid AS rowid, m.passage_idx AS passageIdx, m.char_start AS charStart, document_passages.body AS body
      FROM document_passage_map m JOIN document_passages ON document_passages.rowid = m.passage_rowid
      WHERE m.doc_id = ? ORDER BY m.passage_idx
    `).all(docId);
  }

  /**
   * BM25 scores for the hybrid's lexical side. Any query word may match
   * (lexical-only search requires all of them), so partial matches still
   * rank above none -- dense ranking handles the rest. Higher is better.
   */
  lexicalScores(docId, query) {
    const q = ftsQuery(query, { any: true });
    if (!q) return new Map();
    const rows = this.db.prepare(`
      SELECT m.passage_rowid AS rowid, bm25(document_passages) AS rank
      FROM document_passages JOIN document_passage_map m ON m.passage_rowid = document_passages.rowid
      WHERE document_passages MATCH ? AND m.doc_id = ?
    `).all(q, docId);
    return new Map(rows.map((r) => [r.rowid, -r.rank]));
  }

  /** A document's chunk vectors under one model: Map(passage rowid -> Float32Array[], one per chunk). */
  chunkVectors(docId, modelKey) {
    const out = new Map();
    for (const r of this.db.prepare('SELECT passage_rowid, vec FROM document_chunks WHERE doc_id = ? AND model_key = ? ORDER BY passage_rowid, chunk').all(docId, modelKey)) {
      const buf = r.vec;
      if (!out.has(r.passage_rowid)) out.set(r.passage_rowid, []);
      out.get(r.passage_rowid).push(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4).slice());
    }
    return out;
  }

  /** rows: [{ rowid (passage), vecs: Float32Array[] (its chunks, in order) }]. */
  putChunkVectors(docId, modelKey, rows) {
    const clear = this.db.prepare('DELETE FROM document_chunks WHERE passage_rowid = ? AND model_key = ?');
    const put = this.db.prepare('INSERT INTO document_chunks (passage_rowid, doc_id, model_key, chunk, vec) VALUES (?, ?, ?, ?, ?)');
    this.db.exec('BEGIN');
    try {
      for (const { rowid, vecs } of rows) {
        clear.run(rowid, modelKey);
        vecs.forEach((vec, chunk) => put.run(rowid, docId, modelKey, chunk, Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength)));
      }
      this.db.exec('COMMIT');
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }

  /** Documents with passages not yet embedded under this model (for backfill). */
  documentsMissingVectors(modelKey) {
    return this.db.prepare(`
      SELECT DISTINCT m.doc_id AS id FROM document_passage_map m
      LEFT JOIN document_chunks c ON c.passage_rowid = m.passage_rowid AND c.model_key = ?
      WHERE c.passage_rowid IS NULL
    `).all(modelKey).map((r) => r.id);
  }

  /** Drops vectors from models (or chunkings) no longer configured. */
  pruneVectors(keepModelKey) {
    return this.db.prepare('DELETE FROM document_chunks WHERE model_key != ?').run(keepModelKey).changes;
  }

  /* ---------- search ---------- */

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

  /* ---------- users ---------- */

  getPrefs(userId) {
    const out = {};
    for (const r of this.db.prepare('SELECT key, value FROM user_prefs WHERE user_id = ?').all(userId)) out[r.key] = r.value;
    return out;
  }

  setPref(userId, key, value) {
    if (value == null) this.db.prepare('DELETE FROM user_prefs WHERE user_id = ? AND key = ?').run(userId, key);
    else this.db.prepare(`INSERT INTO user_prefs (user_id, key, value) VALUES (?, ?, ?)
      ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`).run(userId, key, String(value));
  }

  getUser(id) {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
  }

  listUsers() {
    return this.db.prepare(`
      SELECT u.id, u.email, u.name, u.role, u.status, u.external_id, u.created_at, u.last_login_at,
             (SELECT COUNT(*) FROM chats c WHERE c.user_id = u.id) AS chat_count
      FROM users u ORDER BY u.created_at ASC
    `).all();
  }

  /** Admin-side changes only: role in (admin,user), status in (pending,approved,disabled). */
  updateUser(id, { role, status } = {}) {
    const sets = []; const vals = [];
    if (role !== undefined) { sets.push('role = ?'); vals.push(role); }
    if (status !== undefined) {
      sets.push('status = ?'); vals.push(status);
      if (status === 'approved') { sets.push('approved_at = COALESCE(approved_at, ?)'); vals.push(Date.now()); }
    }
    if (sets.length) this.db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    return this.getUser(id);
  }
}

/* ---------- row <-> message shapes ---------- */

function base(row) {
  const msg = { role: row.role };
  if (row.tool_call_id) msg.tool_call_id = row.tool_call_id;
  if (row.tool_calls_json) msg.tool_calls = JSON.parse(row.tool_calls_json);
  if (row.reasoning_details_json) msg.reasoning_details = JSON.parse(row.reasoning_details_json);
  if (row.images_json) msg.images = JSON.parse(row.images_json);
  return msg;
}

function automationView(row) {
  return {
    id: row.id, userId: row.user_id, chatId: row.chat_id, chatTitle: row.chat_title,
    name: row.name, prompt: row.prompt, cron: row.cron, timezone: row.timezone,
    enabled: Boolean(row.enabled), nextRunAt: row.next_run_at, lastRunAt: row.last_run_at,
    lastStatus: row.last_status, lastResult: row.last_result, source: row.source,
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}

/**
 * What the model sees. A demoted tool message sends its stub; everything else
 * sends its content verbatim. Reasoning text is dropped here -- `buildMessages`
 * in llm.js strips it anyway, and it has no place in a cached prefix.
 */
export function toWire(row) {
  const msg = base(row);
  msg.content = row.role === 'tool' ? (row.stub_text ?? row.content) : (row.content ?? null);
  // An epoch took these images off the wire. The note is a pure function of
  // the row, so every rebuild sends the same bytes.
  if (row.images_dropped && msg.images?.length) {
    const n = msg.images.length;
    msg.content = `${msg.content ?? ''}\n\n[${n} image${n === 1 ? '' : 's'} attached here ${n === 1 ? 'was' : 'were'} removed from context to save space. Ask the user to re-attach if you need to look again.]`;
    delete msg.images;
  }
  // A model that was sent images needs the OpenAI multimodal shape -- an array
  // of parts rather than a plain string. Built only when there are images, so
  // every text-only turn keeps sending the plain string it always has, which
  // is what most of the caching machinery in llm.js assumes.
  if (msg.images?.length) {
    const parts = [];
    if (msg.content) parts.push({ type: 'text', text: msg.content });
    for (const img of msg.images) {
      parts.push({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.data}` } });
    }
    msg.content = parts;
  }
  delete msg.images;
  return msg;
}

/** What the transcript shows: always the full text, stub or not. */
export function toView(row) {
  const msg = base(row);
  // The client needs a handle on each message to be able to rewind to one.
  msg.seq = row.seq;
  msg.content = row.content ?? null;
  if (row.reasoning) msg.reasoning = row.reasoning;
  if (row.usage_json) msg.usage = JSON.parse(row.usage_json);
  if (row.stub_text) msg.compacted = true;
  return msg;
}
