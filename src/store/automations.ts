import { scope, ownerOf, type Scope } from './scope.ts';
import { randomBytes } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

interface AutomationRow {
  id: string; user_id: string | null; chat_id: string; chat_title: string;
  name: string; prompt: string; cron: string; timezone: string;
  enabled: number; next_run_at: number | null; last_run_at: number | null;
  last_status: string | null; last_result: string | null; source: string;
  created_at: number; updated_at: number;
}

export interface RunRow {
  id: string; automation_id: string; scheduled_at: number; started_at: number | null;
  finished_at: number | null; status: string; trigger_type: string; result: string | null; error: string | null;
}

export interface AutomationPatch {
  chatId?: string; name?: string; prompt?: string; cron?: string; timezone?: string; enabled?: boolean;
  nextRunAt?: number | null; lastRunAt?: number | null; lastStatus?: string; lastResult?: string;
}

export interface RunPatch { status?: string; startedAt?: number; finishedAt?: number; result?: string | null; error?: string | null }

// Scheduled automations and their runs.
// One area of the Store; see index.js.

// Takes the row as node:sqlite returns it, so callers can map query results straight through.
function automationView(r: unknown) {
  const row = r as AutomationRow;
  return {
    id: row.id, userId: row.user_id, chatId: row.chat_id, chatTitle: row.chat_title,
    name: row.name, prompt: row.prompt, cron: row.cron, timezone: row.timezone,
    enabled: Boolean(row.enabled), nextRunAt: row.next_run_at, lastRunAt: row.last_run_at,
    lastStatus: row.last_status, lastResult: row.last_result, source: row.source,
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}

export type Automation = ReturnType<typeof automationView>;

export class AutomationStore {
  db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  claimUnowned(userId: string): void {
    this.db.prepare('UPDATE automations SET user_id = ? WHERE user_id IS NULL').run(userId);
  }

  list(userId: Scope): Automation[] {
    const s = scope(userId, 'a.user_id');
    return this.db.prepare(`SELECT a.*, c.title AS chat_title FROM automations a JOIN chats c ON c.id=a.chat_id
      WHERE ${s.sql} ORDER BY a.updated_at DESC`).all(...s.params).map(automationView);
  }

  listAll(): Automation[] {
    return this.db.prepare(`SELECT a.*, c.title AS chat_title FROM automations a JOIN chats c ON c.id=a.chat_id
      ORDER BY a.updated_at DESC`).all().map(automationView);
  }

  get(id: string, userId: Scope): Automation | null {
    const s = scope(userId, 'a.user_id');
    const row = this.db.prepare(`SELECT a.*, c.title AS chat_title FROM automations a JOIN chats c ON c.id=a.chat_id
      WHERE a.id=? AND ${s.sql}`).get(id, ...s.params);
    return row ? automationView(row) : null;
  }

  create(data: { chatId: string; name: string; prompt: string; cron: string; timezone: string; enabled?: boolean; nextRunAt: number | null; source?: string },
    userId: Scope): Automation | null {
    scope(userId);
    const id = randomBytes(12).toString('hex');
    const now = Date.now();
    this.db.prepare(`INSERT INTO automations
      (id,user_id,chat_id,name,prompt,cron,timezone,enabled,next_run_at,source,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,ownerOf(userId),data.chatId,data.name,data.prompt,data.cron,data.timezone,
      data.enabled === false ? 0 : 1,data.nextRunAt,data.source || 'user',now,now);
    return this.get(id,userId);
  }

  update(id: string, patch: AutomationPatch, userId: Scope): Automation | null {
    const current = this.get(id,userId);
    if (!current) return null;
    const fields: Record<keyof AutomationPatch, string> = { chatId:'chat_id', name:'name', prompt:'prompt', cron:'cron', timezone:'timezone', enabled:'enabled', nextRunAt:'next_run_at', lastRunAt:'last_run_at', lastStatus:'last_status', lastResult:'last_result' };
    const sets = ['updated_at=?'];
    const values: SQLInputValue[] = [Date.now()];
    for (const [key,col] of Object.entries(fields) as [keyof AutomationPatch, string][]) if (patch[key] !== undefined) {
      sets.push(`${col}=?`); values.push(key === 'enabled' ? (patch[key] ? 1 : 0) : patch[key] as SQLInputValue);
    }
    values.push(id);
    this.db.prepare(`UPDATE automations SET ${sets.join(',')} WHERE id=?`).run(...values);
    return this.get(id,userId);
  }

  delete(id: string, userId: Scope): boolean {
    const s = scope(userId);
    return this.db.prepare(`DELETE FROM automations WHERE id=? AND ${s.sql}`).run(id, ...s.params).changes > 0;
  }

  /** Drops every automation that posts into a chat (the chat is going). */
  deleteForChat(chatId: string): void {
    this.db.prepare('DELETE FROM automations WHERE chat_id = ?').run(chatId);
  }

  /** When the next enabled automation is due, or null when none is. */
  nextDue(): number | null {
    return (this.db.prepare('SELECT MIN(next_run_at) AS due FROM automations WHERE enabled=1').get()?.due as number | null | undefined) ?? null;
  }

  due(now = Date.now()): Automation[] {
    return this.db.prepare(`SELECT a.*, c.title AS chat_title FROM automations a JOIN chats c ON c.id=a.chat_id
      WHERE a.enabled=1 AND a.next_run_at<=? ORDER BY a.next_run_at`).all(now).map(automationView);
  }

  addRun(automationId: string, scheduledAt: number, status = 'queued', triggerType = 'schedule'): string {
    const id = randomBytes(12).toString('hex');
    this.db.prepare(`INSERT INTO automation_runs(id,automation_id,scheduled_at,status,trigger_type) VALUES(?,?,?,?,?)`)
      .run(id,automationId,scheduledAt,status,triggerType);
    return id;
  }

  updateRun(id: string, patch: RunPatch): void {
    const fields: Record<keyof RunPatch, string> = { status:'status', startedAt:'started_at', finishedAt:'finished_at', result:'result', error:'error' };
    const sets: string[] = []; const values: SQLInputValue[] = [];
    for (const [key,col] of Object.entries(fields) as [keyof RunPatch, string][]) if (patch[key] !== undefined) { sets.push(`${col}=?`); values.push(patch[key]); }
    if (sets.length) this.db.prepare(`UPDATE automation_runs SET ${sets.join(',')} WHERE id=?`).run(...values,id);
    const row = this.db.prepare('SELECT * FROM automation_runs WHERE id=?').get(id) as RunRow | undefined;
    const owner = (this.db.prepare('SELECT user_id FROM automations WHERE id=?').get(row?.automation_id ?? null)?.user_id as string | null | undefined) ?? null;
    if (row) this.update(row.automation_id, {
      lastRunAt: row.started_at || row.scheduled_at, lastStatus: row.status,
      ...(row.result !== null ? { lastResult: row.result.slice(0, 4000) } : {})
    }, owner);
  }

  listRuns(automationId: string, userId: Scope, limit = 10): Omit<RunRow, 'automation_id'>[] | null {
    const owned = this.get(automationId,userId);
    if (!owned) return null;
    return this.db.prepare('SELECT id,scheduled_at,started_at,finished_at,status,trigger_type,result,error FROM automation_runs WHERE automation_id=? ORDER BY scheduled_at DESC LIMIT ?')
      .all(automationId,Math.min(50,Math.max(1,limit))) as unknown as Omit<RunRow, 'automation_id'>[];
  }

  recoverRuns(now = Date.now()) {
    const rows = this.db.prepare("SELECT id FROM automation_runs WHERE status IN ('queued','running')").all() as { id: string }[];
    for (const row of rows) this.updateRun(row.id, {
      status: 'failed', finishedAt: now, error: 'Server restarted during this run.'
    });
  }
}
