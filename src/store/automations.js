import { scope, ownerOf } from './scope.js';
import { randomBytes } from 'node:crypto';

// Scheduled automations and their runs.
// One area of the Store; see index.js.

function automationView(row) {
  return {
    id: row.id, userId: row.user_id, chatId: row.chat_id, chatTitle: row.chat_title,
    name: row.name, prompt: row.prompt, cron: row.cron, timezone: row.timezone,
    enabled: Boolean(row.enabled), nextRunAt: row.next_run_at, lastRunAt: row.last_run_at,
    lastStatus: row.last_status, lastResult: row.last_result, source: row.source,
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}

export class AutomationStore {
  constructor(db, deps = {}) {
    this.db = db;
    Object.assign(this, deps);
  }

  list(userId) {
    const s = scope(userId, 'a.user_id');
    return this.db.prepare(`SELECT a.*, c.title AS chat_title FROM automations a JOIN chats c ON c.id=a.chat_id
      WHERE ${s.sql} ORDER BY a.updated_at DESC`).all(...s.params).map(automationView);
  }

  listAll() {
    return this.db.prepare(`SELECT a.*, c.title AS chat_title FROM automations a JOIN chats c ON c.id=a.chat_id
      ORDER BY a.updated_at DESC`).all().map(automationView);
  }

  get(id, userId) {
    const s = scope(userId, 'a.user_id');
    const row = this.db.prepare(`SELECT a.*, c.title AS chat_title FROM automations a JOIN chats c ON c.id=a.chat_id
      WHERE a.id=? AND ${s.sql}`).get(id, ...s.params);
    return row ? automationView(row) : null;
  }

  create(data, userId) {
    scope(userId);
    const id = randomBytes(12).toString('hex');
    const now = Date.now();
    this.db.prepare(`INSERT INTO automations
      (id,user_id,chat_id,name,prompt,cron,timezone,enabled,next_run_at,source,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,ownerOf(userId),data.chatId,data.name,data.prompt,data.cron,data.timezone,
      data.enabled === false ? 0 : 1,data.nextRunAt,data.source || 'user',now,now);
    return this.get(id,userId);
  }

  update(id, patch, userId) {
    const current = this.get(id,userId);
    if (!current) return null;
    const fields = { chatId:'chat_id', name:'name', prompt:'prompt', cron:'cron', timezone:'timezone', enabled:'enabled', nextRunAt:'next_run_at', lastRunAt:'last_run_at', lastStatus:'last_status', lastResult:'last_result' };
    const sets = ['updated_at=?'];
    const values = [Date.now()];
    for (const [key,col] of Object.entries(fields)) if (patch[key] !== undefined) {
      sets.push(`${col}=?`); values.push(key === 'enabled' ? (patch[key] ? 1 : 0) : patch[key]);
    }
    values.push(id);
    this.db.prepare(`UPDATE automations SET ${sets.join(',')} WHERE id=?`).run(...values);
    return this.get(id,userId);
  }

  delete(id, userId) {
    const s = scope(userId);
    return this.db.prepare(`DELETE FROM automations WHERE id=? AND ${s.sql}`).run(id, ...s.params).changes > 0;
  }

  /** Drops every automation that posts into a chat (the chat is going). */
  deleteForChat(chatId) {
    this.db.prepare('DELETE FROM automations WHERE chat_id = ?').run(chatId);
  }

  /** When the next enabled automation is due, or null when none is. */
  nextDue() {
    return this.db.prepare('SELECT MIN(next_run_at) AS due FROM automations WHERE enabled=1').get()?.due ?? null;
  }

  due(now = Date.now()) {
    return this.db.prepare(`SELECT a.*, c.title AS chat_title FROM automations a JOIN chats c ON c.id=a.chat_id
      WHERE a.enabled=1 AND a.next_run_at<=? ORDER BY a.next_run_at`).all(now).map(automationView);
  }

  addRun(automationId, scheduledAt, status = 'queued', triggerType = 'schedule') {
    const id = randomBytes(12).toString('hex');
    this.db.prepare(`INSERT INTO automation_runs(id,automation_id,scheduled_at,status,trigger_type) VALUES(?,?,?,?,?)`)
      .run(id,automationId,scheduledAt,status,triggerType);
    return id;
  }

  updateRun(id, patch) {
    const fields = { status:'status', startedAt:'started_at', finishedAt:'finished_at', result:'result', error:'error' };
    const sets = []; const values = [];
    for (const [key,col] of Object.entries(fields)) if (patch[key] !== undefined) { sets.push(`${col}=?`); values.push(patch[key]); }
    if (sets.length) this.db.prepare(`UPDATE automation_runs SET ${sets.join(',')} WHERE id=?`).run(...values,id);
    const row = this.db.prepare('SELECT * FROM automation_runs WHERE id=?').get(id);
    const owner = this.db.prepare('SELECT user_id FROM automations WHERE id=?').get(row?.automation_id)?.user_id ?? null;
    if (row) this.update(row.automation_id, {
      lastRunAt: row.started_at || row.scheduled_at, lastStatus: row.status,
      ...(row.result !== null ? { lastResult: row.result.slice(0, 4000) } : {})
    }, owner);
  }

  listRuns(automationId, userId, limit = 10) {
    const owned = this.get(automationId,userId);
    if (!owned) return null;
    return this.db.prepare('SELECT id,scheduled_at,started_at,finished_at,status,trigger_type,result,error FROM automation_runs WHERE automation_id=? ORDER BY scheduled_at DESC LIMIT ?')
      .all(automationId,Math.min(50,Math.max(1,limit)));
  }

  recoverRuns(now = Date.now()) {
    const rows = this.db.prepare("SELECT id FROM automation_runs WHERE status IN ('queued','running')").all();
    for (const row of rows) this.updateRun(row.id, {
      status: 'failed', finishedAt: now, error: 'Server restarted during this run.'
    });
  }
}
