/* The database shape: tables, triggers, the schema version, and the migrations that reach it. */

export const SCHEMA = `
-- Optional auth/RBAC (config authMode 'single'/'multiuser'). Unused and
-- empty when authMode is explicitly 'none' -- these tables cost nothing
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

-- Requests made on a chat's behalf that are not turns of it (an LLM
-- checkpoint summary): billed, so counted in usage, never shown as messages.
CREATE TABLE IF NOT EXISTS aux_usage (
  id         INTEGER PRIMARY KEY,
  chat_id    TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  model      TEXT,
  usage_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
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

-- Every status change, with the status it replaced, so a rewind can play them back.
CREATE TABLE IF NOT EXISTS task_changes (
  chat_id     TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  prev_status TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS task_changes_chat ON task_changes(chat_id, seq);

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

-- The uploaded files as they came in, so the artifacts rail can open the real
-- thing. Keyed by md5 so the same file attached to many chats is stored once;
-- documents.md5 points here, and a blob goes when its last document does. Its
-- own table, not a documents column: documents rows are read whole
-- (SELECT d.*) by read_document and the text route, which must not drag
-- megabytes of bytes along. md5 is a content fingerprint here, not a defence.
CREATE TABLE IF NOT EXISTS document_blobs (
  md5  TEXT PRIMARY KEY,
  data BLOB NOT NULL
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

-- Dense retrieval (retrieval.mode 'dense' / 'hybrid') for every corpus
-- retrieval.js searches: the embedded chunks of one searchable unit (a
-- document passage, a chat turn), one float32 vector per chunk, per model.
-- owner_id is what the unit belongs to (document id, chat id), for cleanup.
-- model_key names the model (and chunking), so switching re-embeds instead
-- of mixing incompatible vectors -- the rule TinyContext follows too. digest
-- is the embedded text's hash for units whose text can change ('' otherwise).
CREATE TABLE IF NOT EXISTS embeddings (
  corpus    TEXT NOT NULL,
  unit_id   INTEGER NOT NULL,
  owner_id  TEXT NOT NULL,
  model_key TEXT NOT NULL,
  digest    TEXT NOT NULL,
  chunk     INTEGER NOT NULL,
  vec       BLOB NOT NULL,
  PRIMARY KEY (corpus, unit_id, model_key, chunk)
);
CREATE INDEX IF NOT EXISTS embeddings_owner ON embeddings(corpus, owner_id, model_key);

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
 * Bumped whenever the constructor's migrations change the shape of the
 * database. Stored in SQLite's user_version, so deployments can see where a
 * file stands and run migrations deliberately (`tinywebui migrate`).
 */
export const SCHEMA_VERSION = 12;

/**
 * Adds a column if it isn't already there. `CREATE TABLE IF NOT EXISTS` is a
 * no-op against a live table, so a column added to a table's shape after
 * installs already exist has to be self-repaired this way instead -- the
 * same pattern `model`/`created_at`/`images_json` already use below for
 * `messages`. `ALTER TABLE ADD COLUMN` itself has no IF NOT EXISTS form.
 */
function ensureColumn(db, table, col, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
}

/**
 * Schema 4 renamed "chunks" to what they are: document_chunks (FTS) and
 * its map became document_passages / document_passage_map, and the name
 * document_chunks now holds embedded chunks. Must run before SCHEMA, which
 * would otherwise see the old FTS table under the new chunk table's name.
 */
function renameToPassages(db) {
  const has = (name) => Boolean(db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(name));
  if (has('document_chunk_map')) {
    db.exec('BEGIN');
    try {
      db.exec('ALTER TABLE document_chunks RENAME TO document_passages');
      db.exec('ALTER TABLE document_chunk_map RENAME TO document_passage_map');
      db.exec('ALTER TABLE document_passage_map RENAME COLUMN chunk_rowid TO passage_rowid');
      db.exec('ALTER TABLE document_passage_map RENAME COLUMN chunk_idx TO passage_idx');
      db.exec('DROP INDEX IF EXISTS document_chunk_map_doc');
      db.exec('COMMIT');
    } catch (err) { db.exec('ROLLBACK'); throw err; }
  }
  // Vectors from the unreleased schema 3 layout: recomputed by the backfill.
  db.exec('DROP TABLE IF EXISTS document_chunk_embeddings');
}

/** Schema 7 and earlier kept document vectors in their own table; they move into `embeddings` as-is. */
function moveDocumentVectors(db) {
  const cols = db.prepare('PRAGMA table_info(document_chunks)').all().map((c) => c.name);
  if (!cols.includes('vec')) return;
  db.exec('BEGIN');
  try {
    db.exec(`INSERT OR IGNORE INTO embeddings (corpus, unit_id, owner_id, model_key, digest, chunk, vec)
      SELECT 'documents', passage_rowid, doc_id, model_key, '', chunk, vec FROM document_chunks`);
    db.exec('DROP TABLE document_chunks');
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}

/** Brings an open database to SCHEMA_VERSION. `fresh`: it has no tables yet. */
export function migrate(db, { fresh }) {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  if (!fresh) renameToPassages(db);
  db.exec(SCHEMA);
  if (!fresh) moveDocumentVectors(db);
  // Nullable everywhere: unused (null) when auth is off, the exact behavior
  // installs already have; set only once per-user scoping is opted into.
  ensureColumn(db, 'chats', 'user_id', 'TEXT');
  ensureColumn(db, 'chats', 'folder', 'TEXT');
  ensureColumn(db, 'chats', 'tags_json', "TEXT NOT NULL DEFAULT '[]'");
  // First message the model still sees once the hard window has moved; -1
  // until it ever has. See planWindow in compact.js.
  ensureColumn(db, 'chats', 'window_seq', 'INTEGER NOT NULL DEFAULT -1');
  // LLM summary of what the window cut off, as JSON { summary, throughSeq,
  // scopeStart, model }; NULL when there is none. Only valid together with
  // window_seq, so the two are always written in one statement.
  ensureColumn(db, 'chats', 'checkpoint_json', 'TEXT');
  // The message seq a task was added at, so a rewind past it removes it. -1
  // for tasks from before this was tracked: no rewind reaches them.
  ensureColumn(db, 'tasks', 'created_seq', 'INTEGER NOT NULL DEFAULT -1');
  // Set once an epoch has taken a message's images off the wire; the images
  // themselves stay in images_json for the transcript.
  ensureColumn(db, 'messages', 'images_dropped', 'INTEGER NOT NULL DEFAULT 0');
  // Where a message came from when it was not typed by the user, e.g. an
  // automation run: the page draws it as that, not as a user bubble. The
  // model still gets `content` as an ordinary user turn.
  ensureColumn(db, 'messages', 'origin_json', 'TEXT');
  ensureColumn(db, 'documents', 'user_id', 'TEXT');
  // The passage split a document was stored with; NULL means the original
  // 1800/200, from before it was configurable.
  ensureColumn(db, 'documents', 'passage_size', 'INTEGER');
  ensureColumn(db, 'documents', 'passage_overlap', 'INTEGER');
  // Fingerprint of the uploaded bytes (see document_blobs); NULL for documents
  // stored before originals were kept.
  ensureColumn(db, 'documents', 'md5', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS documents_md5 ON documents(md5)');
  ensureColumn(db, 'artifacts', 'user_id', 'TEXT');
  ensureColumn(db, 'automation_runs', 'trigger_type', "TEXT NOT NULL DEFAULT 'schedule'");
  // Trusted-header auth: the gateway's immutable subject. Email and name are
  // metadata reconciled from the gateway; external_id decides who owns what.
  ensureColumn(db, 'users', 'external_id', 'TEXT');
  ensureColumn(db, 'users', 'name', 'TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_external_id ON users(external_id)');
  // Per-user preferences (tier 3): harmless choices like which allowed
  // model to use. Deployment settings never live here.
  db.exec(`CREATE TABLE IF NOT EXISTS user_prefs (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key     TEXT NOT NULL,
    value   TEXT,
    PRIMARY KEY (user_id, key)
  )`);
  // `messages` may already exist from before these columns did --
  // CREATE TABLE IF NOT EXISTS above is a no-op against a live table, so
  // they're added here instead, self-repairing like the FTS backfill below.
  const cols = db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
  if (!cols.includes('model')) db.exec('ALTER TABLE messages ADD COLUMN model TEXT');
  if (!cols.includes('created_at')) db.exec('ALTER TABLE messages ADD COLUMN created_at INTEGER');
  if (!cols.includes('images_json')) db.exec('ALTER TABLE messages ADD COLUMN images_json TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS messages_usage_ts ON messages(created_at) WHERE usage_json IS NOT NULL');
  // A tool row, or an assistant note later superseded within its own turn,
  // indexed under an earlier shape of the triggers above is corrected on
  // open rather than left to linger -- the triggers alone only ever
  // prevent NEW drift, not clean up old drift.
  db.exec(`
    DELETE FROM messages_fts WHERE rowid IN (
      SELECT id FROM messages WHERE role NOT IN ('user', 'assistant', 'system')
    )
  `);
  db.exec(SUPERSEDE_CLEANUP);
  // The triggers keep the index in step with every write from here on, but
  // they cannot backfill history that predates them -- a database from
  // before search existed opens with a `messages_fts` that is real but
  // empty for rows that should be in it. A count mismatch, restricted to
  // the roles that belong in the index, is also what any other divergence
  // would look like, so this doubles as self-repair: whatever is missing
  // is added, nothing already correct is touched.
  const { m, f } = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM messages WHERE role IN ('user', 'assistant', 'system')) AS m,
      (SELECT COUNT(*) FROM messages_fts) AS f
  `).get();
  if (m !== f) {
    db.exec(`
      INSERT INTO messages_fts(rowid, body)
      SELECT id, coalesce(content, '')
      FROM messages
      WHERE role IN ('user', 'assistant', 'system')
        AND id NOT IN (SELECT rowid FROM messages_fts)
    `);
  }
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}
