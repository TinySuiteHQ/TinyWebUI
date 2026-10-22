import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

export type UserRole = 'admin' | 'user';
export type UserStatus = 'pending' | 'approved' | 'disabled';

export interface UserRow {
  id: string;
  email: string | null;
  name: string | null;
  google_sub: string | null;
  external_id: string | null;
  password_hash: string | null;
  role: UserRole;
  status: UserStatus;
  created_at: number;
  approved_at: number | null;
  last_login_at: number | null;
}

export type UserListing = Pick<UserRow, 'id' | 'email' | 'name' | 'role' | 'status' | 'external_id' | 'created_at' | 'last_login_at'>
  & { chat_count: number };

export interface SessionRow { token_hash: string; user_id: string; created_at: number; expires_at: number }
export interface InviteRow { id: string; email: string | null; created_by: string; created_at: number; expires_at: number }
interface InviteRecord extends InviteRow { token_hash: string; used_at: number | null; used_by: string | null }

/** The identity columns a gateway sync may write. */
export type UserSync = Partial<Pick<UserRow, 'email' | 'name' | 'role' | 'status' | 'last_login_at'>>;

// Users, their preferences, and login sessions.
// One area of the Store; see index.js.

export class UserStore {
  db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  getPrefs(userId: string): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    for (const r of this.db.prepare('SELECT key, value FROM user_prefs WHERE user_id = ?').all(userId) as { key: string; value: string | null }[]) out[r.key] = r.value;
    return out;
  }

  setPref(userId: string, key: string, value: unknown): void {
    if (value == null) this.db.prepare('DELETE FROM user_prefs WHERE user_id = ? AND key = ?').run(userId, key);
    else this.db.prepare(`INSERT INTO user_prefs (user_id, key, value) VALUES (?, ?, ?)
      ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`).run(userId, key, String(value));
  }

  get(id: string): UserRow | null {
    return (this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined) || null;
  }

  count(): number {
    return this.db.prepare('SELECT COUNT(*) AS n FROM users').get()!.n as number;
  }

  localCount(): number {
    return this.db.prepare('SELECT COUNT(*) AS n FROM users WHERE password_hash IS NOT NULL').get()!.n as number;
  }

  byEmail(email: string): UserRow | null {
    return (this.db.prepare('SELECT * FROM users WHERE email = ?').get(email) as UserRow | undefined) || null;
  }

  list(): UserListing[] {
    return this.db.prepare(`
      SELECT u.id, u.email, u.name, u.role, u.status, u.external_id, u.created_at, u.last_login_at,
             (SELECT COUNT(*) FROM chats c WHERE c.user_id = u.id) AS chat_count
      FROM users u ORDER BY u.created_at ASC
    `).all() as unknown as UserListing[];
  }

  /** Admin-side changes only: role in (admin,user), status in (pending,approved,disabled). */
  update(id: string, { role, status }: { role?: UserRole; status?: UserStatus } = {}): UserRow | null {
    const sets: string[] = []; const vals: SQLInputValue[] = [];
    if (role !== undefined) { sets.push('role = ?'); vals.push(role); }
    if (status !== undefined) {
      sets.push('status = ?'); vals.push(status);
      if (status === 'approved') { sets.push('approved_at = COALESCE(approved_at, ?)'); vals.push(Date.now()); }
    }
    if (sets.length) this.db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    return this.get(id);
  }

  byExternalId(externalId: string): UserRow | null {
    return (this.db.prepare('SELECT * FROM users WHERE external_id = ?').get(externalId) as UserRow | undefined) || null;
  }

  /** Whether another account already holds this email (emails are unique). */
  emailTaken(email: string, exceptId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').get(email, exceptId));
  }

  /**
   * Creates the user a gateway vouched for, unless one with that external id
   * exists. The unique index makes this atomic: concurrent first requests race
   * to insert, exactly one wins. Returns { user, created }.
   */
  provision({ externalId, role, status, now = Date.now() }: { externalId: string; role: UserRole; status: UserStatus; now?: number }):
    { user: UserRow | null; created: boolean } {
    const created = this.db.prepare(`
      INSERT INTO users (id, external_id, role, status, created_at, approved_at, last_login_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(external_id) DO NOTHING
    `).run(randomUUID(), externalId, role, status, now, status === 'approved' ? now : null, now).changes > 0;
    return { user: this.byExternalId(externalId), created };
  }

  /** Gateway-side sync of identity metadata; only these columns can be set. */
  sync(id: string, fields: UserSync): UserRow | null {
    const allowed = ['email', 'name', 'role', 'status', 'last_login_at'];
    const keys = (Object.keys(fields) as (keyof UserSync)[]).filter((k) => allowed.includes(k));
    if (keys.length) this.db.prepare(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k] as SQLInputValue), id);
    return this.get(id);
  }

  /** The single approved admin account behind a 'single' password. */
  ensureOwner(id: string): void {
    const now = Date.now();
    this.db.prepare(`INSERT INTO users (id, role, status, created_at, approved_at)
      VALUES (?, 'admin', 'approved', ?, ?) ON CONFLICT(id) DO NOTHING`).run(id, now, now);
  }

  removePasswordless(id: string): void {
    this.db.prepare('DELETE FROM users WHERE id = ? AND password_hash IS NULL AND external_id IS NULL').run(id);
  }

  /** Atomically claims a fresh local installation. Exactly one caller wins. */
  createFirstLocal({ email, passwordHash, now = Date.now() }: { email: string; passwordHash: string; now?: number }): UserRow | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.localCount() !== 0) { this.db.exec('ROLLBACK'); return null; }
      const id = randomUUID();
      this.db.prepare(`INSERT INTO users
        (id, email, password_hash, role, status, created_at, approved_at, last_login_at)
        VALUES (?, ?, ?, 'admin', 'approved', ?, ?, ?)`)
        .run(id, email, passwordHash, now, now, now);
      this.db.exec('COMMIT');
      return this.get(id);
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }

  createInvite({ id, tokenHash, email, createdBy, createdAt = Date.now(), expiresAt }:
    { id: string; tokenHash: string; email: string | null; createdBy: string; createdAt?: number; expiresAt: number }): InviteRow {
    this.db.prepare(`INSERT INTO invitations
      (id, token_hash, email, created_by, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, tokenHash, email, createdBy, createdAt, expiresAt);
    return this.db.prepare('SELECT id, email, created_by, created_at, expires_at FROM invitations WHERE id = ?').get(id) as unknown as InviteRow;
  }

  listInvites(now = Date.now()): InviteRow[] {
    return this.db.prepare(`SELECT id, email, created_by, created_at, expires_at
      FROM invitations WHERE used_at IS NULL AND expires_at > ? ORDER BY created_at DESC`).all(now) as unknown as InviteRow[];
  }

  revokeInvite(id: string): boolean {
    return this.db.prepare('DELETE FROM invitations WHERE id = ? AND used_at IS NULL').run(id).changes > 0;
  }

  /** Claims a valid invitation and creates its approved local user in one transaction. */
  acceptInvite({ tokenHash, email, passwordHash, now = Date.now() }: { tokenHash: string; email: string; passwordHash: string; now?: number }):
    { error: 'invalid_or_expired' | 'email_mismatch' | 'email_taken'; user?: undefined } | { user: UserRow | null; error?: undefined } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const invite = this.db.prepare('SELECT * FROM invitations WHERE token_hash = ?').get(tokenHash) as InviteRecord | undefined;
      if (!invite || invite.used_at !== null || invite.expires_at <= now) {
        this.db.exec('ROLLBACK');
        return { error: 'invalid_or_expired' };
      }
      if (invite.email && invite.email !== email) {
        this.db.exec('ROLLBACK');
        return { error: 'email_mismatch' };
      }
      if (this.byEmail(email)) {
        this.db.exec('ROLLBACK');
        return { error: 'email_taken' };
      }
      const id = randomUUID();
      this.db.prepare(`INSERT INTO users
        (id, email, password_hash, role, status, created_at, approved_at, last_login_at)
        VALUES (?, ?, ?, 'user', 'approved', ?, ?, ?)`)
        .run(id, email, passwordHash, now, now, now);
      this.db.prepare('UPDATE invitations SET used_at = ?, used_by = ? WHERE id = ?').run(now, id, invite.id);
      this.db.exec('COMMIT');
      return { user: this.get(id) };
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }

  addSession(tokenHash: string, userId: string, expiresAt: number): void {
    this.db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(tokenHash, userId, Date.now(), expiresAt);
  }

  getSession(tokenHash: string): SessionRow | null {
    return (this.db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(tokenHash) as SessionRow | undefined) || null;
  }

  deleteSession(tokenHash: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  deleteUserSessions(userId: string): void {
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }
}
