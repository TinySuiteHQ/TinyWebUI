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
 * One class, one connection. Its methods are written per area in the files
 * next to this one and copied onto Store below, so callers see a single
 * `store.x()` API while each area reads on its own.
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

for (const area of [ChatStore, MessageStore, AutomationStore, UsageStore, DocumentStore, EmbeddingStore, TurnStore, SearchStore, UserStore]) {
  for (const name of Object.getOwnPropertyNames(area.prototype)) {
    if (name !== 'constructor') Object.defineProperty(Store.prototype, name, Object.getOwnPropertyDescriptor(area.prototype, name));
  }
}
