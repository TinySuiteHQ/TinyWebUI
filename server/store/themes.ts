import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ALL_USERS, ownerOf, scope, type Scope } from './scope.ts';

/** An imported theme. `user_id` null: everyone's. */
export interface ThemeRow { id: string; user_id: string | null; name: string; css: string; created_at: number }
export type ThemeListing = Omit<ThemeRow, 'css'>;

// Imported themes. One area of the Store; see index.ts.
//
// A theme is visible to its owner and, when it has none, to everyone. That
// is not the usual scope() filter (which sees one owner's rows), so the
// condition is spelled out here, once, for every read.
function visible(userId: Scope): { sql: string; params: string[] } {
  if (userId === ALL_USERS) return { sql: '1=1', params: [] };
  if (userId === null) return { sql: 'user_id IS NULL', params: [] };
  if (typeof userId === 'string' && userId) return { sql: '(user_id IS NULL OR user_id = ?)', params: [userId] };
  throw new TypeError('store: a user scope is required (pass a user id, null, or ALL_USERS)');
}

export class ThemeStore {
  db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** What `userId` can pick: everyone's themes, then their own, each oldest first. */
  list(userId: Scope): ThemeListing[] {
    const v = visible(userId);
    return this.db.prepare(`SELECT id, user_id, name, created_at FROM themes WHERE ${v.sql}
      ORDER BY user_id IS NOT NULL, created_at, id`).all(...v.params) as unknown as ThemeListing[];
  }

  get(id: string, userId: Scope): ThemeRow | null {
    const v = visible(userId);
    return (this.db.prepare(`SELECT * FROM themes WHERE id = ? AND ${v.sql}`).get(id, ...v.params) as ThemeRow | undefined) || null;
  }

  /** `owner` null (or ALL_USERS) makes it everyone's. */
  add({ owner, name, css }: { owner: Scope; name: string; css: string }): ThemeListing {
    const row = { id: `t-${randomUUID().slice(0, 8)}`, user_id: ownerOf(owner), name, created_at: Date.now() };
    this.db.prepare('INSERT INTO themes (id, user_id, name, css, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(row.id, row.user_id, row.name, css, row.created_at);
    return row;
  }

  /** How many themes `owner` has: a person's own, or (null) everyone's. */
  countOwned(owner: string | null): number {
    const s = scope(owner);
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM themes WHERE ${s.sql}`).get(...s.params) as { n: number }).n;
  }

  remove(id: string): boolean {
    return this.db.prepare('DELETE FROM themes WHERE id = ?').run(id).changes > 0;
  }
}
