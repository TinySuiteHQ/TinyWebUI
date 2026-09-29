import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SCHEMA_VERSION, migrate as migrateSchema } from './schema.js';
import { ChatStore } from './chats.js';
import { MessageStore } from './messages.js';
import { AutomationStore } from './automations.js';
import { UsageStore } from './usage.js';
import { DocumentStore } from './documents.js';
import { EmbeddingStore } from './embeddings.js';
import { TurnStore } from './turns.js';
import { SearchStore } from './search.js';
import { UserStore } from './users.js';

export { SCHEMA_VERSION } from './schema.js';
export { ALL_USERS } from './scope.js';
export { PASSAGE_SIZE, PASSAGE_OVERLAP } from './documents.js';
export { toWire, toView } from './wire.js';

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
 *
 * One connection, one object per area. Every call names its area --
 * `store.chats.list()`, `store.documents.add()` -- and each area lives in the
 * file of the same name next to this one. An area that needs another is
 * handed it here, so every dependency between areas is listed in one place.
 */

/** Thrown when a database is behind and migrating was not allowed. */
export class MigrationRequiredError extends Error {}

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
    migrateSchema(this.db, { fresh });

    const { db } = this;
    this.embeddings = new EmbeddingStore(db);
    this.messages = new MessageStore(db);
    this.automations = new AutomationStore(db);
    this.documents = new DocumentStore(db, { embeddings: this.embeddings });
    this.chats = new ChatStore(db, { messages: this.messages, automations: this.automations, documents: this.documents, embeddings: this.embeddings });
    this.turns = new TurnStore(db, { chats: this.chats });
    this.usage = new UsageStore(db);
    this.search = new SearchStore(db);
    this.users = new UserStore(db);
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
}
