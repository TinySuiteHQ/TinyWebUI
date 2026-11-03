import type { DatabaseSync } from 'node:sqlite';
import type { ThinkingLevel } from '../harness/types.ts';

export interface ModelThinkingRow {
  model_id: string;
  sig: string;
  refused_at: number | null;
  last_level: ThinkingLevel | null;
  last_tokens: number | null;
  last_text: number;
  last_at: number | null;
  quiet_turns: number;
}

/** What one turn that asked for thinking got back: reported reasoning tokens (null when none were reported) and whether reasoning text came back. */
export interface ThinkingSeen { level: ThinkingLevel; tokens: number | null; text: boolean }

// What thinking settings did on each catalog model: refusals, and what the
// last turns reported. One area of the Store; see index.js.

export class ModelThinkingStore {
  db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  get(modelId: string): ModelThinkingRow | null {
    return (this.db.prepare('SELECT * FROM model_thinking WHERE model_id = ?').get(modelId) as ModelThinkingRow | undefined) || null;
  }

  list(): ModelThinkingRow[] {
    return this.db.prepare('SELECT * FROM model_thinking').all() as unknown as ModelThinkingRow[];
  }

  /** The endpoint refused the thinking field under `sig`. Earlier observations were under some other setup or are moot now. */
  refuse(modelId: string, sig: string, now = Date.now()): void {
    this.db.prepare(`INSERT INTO model_thinking (model_id, sig, refused_at) VALUES (?, ?, ?)
      ON CONFLICT(model_id) DO UPDATE SET sig = excluded.sig, refused_at = excluded.refused_at,
        last_level = NULL, last_tokens = NULL, last_text = 0, last_at = NULL, quiet_turns = 0`).run(modelId, sig, now);
  }

  /**
   * A turn that sent a thinking level and was not refused. A new `sig` starts
   * the record over; `quiet_turns` counts turns that asked for thinking and
   * showed no sign of it, since the last one that did. A turn at 'off' says
   * nothing either way, so it leaves the count alone.
   */
  observe(modelId: string, sig: string, seen: ThinkingSeen, now = Date.now()): void {
    const prev = this.get(modelId);
    const before = prev && prev.sig === sig ? prev.quiet_turns : 0;
    const showed = seen.text || Boolean(seen.tokens && seen.tokens > 0);
    const streak = seen.level === 'off' ? before : showed ? 0 : before + 1;
    this.db.prepare(`INSERT INTO model_thinking (model_id, sig, refused_at, last_level, last_tokens, last_text, last_at, quiet_turns)
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?)
      ON CONFLICT(model_id) DO UPDATE SET sig = excluded.sig, refused_at = NULL, last_level = excluded.last_level,
        last_tokens = excluded.last_tokens, last_text = excluded.last_text, last_at = excluded.last_at, quiet_turns = excluded.quiet_turns`)
      .run(modelId, sig, seen.level, seen.tokens, seen.text ? 1 : 0, now, streak);
  }

  /** Forgets everything about a model, so its next turn tries thinking again. */
  forget(modelId: string): boolean {
    return this.db.prepare('DELETE FROM model_thinking WHERE model_id = ?').run(modelId).changes > 0;
  }
}
