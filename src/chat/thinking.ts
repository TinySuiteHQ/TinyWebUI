/**
 * What thinking settings actually do on each catalog model. The OpenAI
 * standard has no way to ask an endpoint whether it takes a thinking level,
 * so this learns from turns instead: a refusal is certain, and the switch is
 * greyed out until the setup changes; reported reasoning is only a hint for
 * the admin, because some providers never report it even when it works.
 */
import { effectiveConfig, findEntry } from '../config/models.ts';
import { thinkingStyle } from '../harness/provider.ts';
import type { Config } from '../config/config.ts';
import type { Store } from '../store/index.ts';
import type { ThinkingSeen } from '../store/model_thinking.ts';
import type { ThinkingLevel } from '../harness/types.ts';
import type { StoredUsage } from '../store/usage.ts';

/**
 * The setup a fact about thinking was learned under: endpoint, provider
 * model and request format. Null for a model with no thinking settings.
 */
export function thinkingSig(cfg: Config, key: string | null | undefined): string | null {
  const e = findEntry(cfg, key ?? cfg.model);
  if (!e?.thinking) return null;
  const c = effectiveConfig(cfg, e.id);
  return [c.baseUrl, c.model, thinkingStyle({ ...c, thinkingSend: e.thinking.send })].join(' ');
}

/** Whether this model's endpoint has refused thinking under its current setup. */
export function thinkingRefused(cfg: Config, store: Store, key: string | null | undefined): boolean {
  const e = findEntry(cfg, key ?? cfg.model);
  const sig = thinkingSig(cfg, key);
  if (!e || !sig) return false;
  const row = store.modelThinking.get(e.id);
  return Boolean(row?.refused_at && row.sig === sig);
}

/** A message a turn added, as runChat returns it. */
type TurnMessage = { role: string; reasoning?: string; usage?: object };

const reportedReasoning = (u: StoredUsage | undefined) =>
  u?.completion_tokens_details?.reasoning_tokens ?? u?.output_tokens_details?.reasoning_tokens ?? u?.reasoning_tokens;

/** What a finished turn showed of thinking, from the assistant messages it added. */
export function seenIn(messages: TurnMessage[], level: ThinkingLevel): ThinkingSeen | null {
  const answers = messages.filter((m) => m.role === 'assistant');
  if (!answers.length) return null;
  // An assistant row's usage is the round's StoredUsage (runChat writes it).
  const counts = answers.map((m) => reportedReasoning(m.usage as StoredUsage | undefined)).filter((n): n is number => typeof n === 'number');
  return {
    level,
    tokens: counts.length ? counts.reduce((a, b) => a + b, 0) : null,
    text: answers.some((m) => Boolean(m.reasoning))
  };
}

/** Records a turn that sent a thinking level: refused outright, or what it reported. */
export function recordThinking(cfg: Config, store: Store, key: string | null | undefined, level: ThinkingLevel,
  { refused, messages }: { refused: boolean; messages: TurnMessage[] }): void {
  const e = findEntry(cfg, key ?? cfg.model);
  const sig = thinkingSig(cfg, key);
  if (!e || !sig) return;
  if (refused) { store.modelThinking.refuse(e.id, sig); return; }
  // A turn that failed before any answer says nothing about thinking.
  const seen = seenIn(messages, level);
  if (seen) store.modelThinking.observe(e.id, sig, seen);
}

/** Per catalog id, what the model editor shows its admin. Facts from an older setup are left out. */
export function thinkingReport(cfg: Config, store: Store) {
  const out: Record<string, { refusedAt: number | null; lastLevel: ThinkingLevel | null; lastTokens: number | null;
    lastText: boolean; lastAt: number | null; quietTurns: number }> = {};
  for (const row of store.modelThinking.list()) {
    if (row.sig !== thinkingSig(cfg, row.model_id)) continue;
    out[row.model_id] = {
      refusedAt: row.refused_at, lastLevel: row.last_level, lastTokens: row.last_tokens,
      lastText: Boolean(row.last_text), lastAt: row.last_at, quietTurns: row.quiet_turns
    };
  }
  return out;
}
