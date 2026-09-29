import { randomUUID } from 'node:crypto';

// Users, their preferences, and login sessions.
// Methods of Store; see index.js.

export class UserStore {
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

  userByExternalId(externalId) {
    return this.db.prepare('SELECT * FROM users WHERE external_id = ?').get(externalId) || null;
  }

  /** Whether another account already holds this email (emails are unique). */
  emailTaken(email, exceptId) {
    return Boolean(this.db.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').get(email, exceptId));
  }

  /**
   * Creates the user a gateway vouched for, unless one with that external id
   * exists. The unique index makes this atomic: concurrent first requests race
   * to insert, exactly one wins. Returns { user, created }.
   */
  provisionUser({ externalId, role, status, now = Date.now() }) {
    const created = this.db.prepare(`
      INSERT INTO users (id, external_id, role, status, created_at, approved_at, last_login_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(external_id) DO NOTHING
    `).run(randomUUID(), externalId, role, status, now, status === 'approved' ? now : null, now).changes > 0;
    return { user: this.userByExternalId(externalId), created };
  }

  /** Gateway-side sync of identity metadata; only these columns can be set. */
  syncUser(id, fields) {
    const allowed = ['email', 'name', 'role', 'status', 'last_login_at'];
    const keys = Object.keys(fields).filter((k) => allowed.includes(k));
    if (keys.length) this.db.prepare(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
    return this.getUser(id);
  }

  /** The single approved admin account behind a 'single' password. */
  ensureOwner(id) {
    const now = Date.now();
    this.db.prepare(`INSERT INTO users (id, role, status, created_at, approved_at)
      VALUES (?, 'admin', 'approved', ?, ?) ON CONFLICT(id) DO NOTHING`).run(id, now, now);
  }

  addSession(tokenHash, userId, expiresAt) {
    this.db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(tokenHash, userId, Date.now(), expiresAt);
  }

  getSession(tokenHash) {
    return this.db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(tokenHash) || null;
  }

  deleteSession(tokenHash) {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  deleteUserSessions(userId) {
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }
}
