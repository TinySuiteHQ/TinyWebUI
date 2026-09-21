/**
 * Context compaction.
 *
 * The append-only rule is what makes prompt caching work: every provider caches
 * on an exact prefix match, so rewriting an earlier message throws away the
 * cache from that point on. But nothing ever leaving is how a four-message
 * research chat reaches 150k tokens, because every tool result is replayed in
 * full on every subsequent turn.
 *
 * The resolution is to rewrite rarely and then stop. When the prompt crosses a
 * threshold we demote old tool results to stubs exactly once, write the stubs
 * back to the store, and from then on that prefix is frozen and byte-identical
 * again. One cache miss buys many cheap turns. The alternative -- ageing
 * messages out every turn -- changes the prefix on every request and never
 * caches anything.
 *
 * Two invariants everything here depends on:
 *
 *  1. Deterministic. A stub is a pure function of the artifact. No model call,
 *     no timestamp, no counter. It is also stored rather than recomputed, so a
 *     later change to this file cannot disturb a frozen prefix.
 *  2. Tool-agnostic. Tool output is an opaque blob from an arbitrary MCP
 *     server. Nothing below may look at a tool's name or know its schema; the
 *     only structure we infer is generic (JSON, XML-ish, or neither).
 */

export const DIGEST_HEAD = 400;
export const DIGEST_TAIL = 200;

/**
 * A one-line shape hint, derived only from generic structure. Gives the model
 * enough to judge whether re-reading is worth a context_expand call, without
 * the stub pretending to summarise content it has not understood.
 */
function outline(text) {
  const trimmed = text.trim();

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return `json array, ${parsed.length} item(s)`;
      if (parsed && typeof parsed === 'object') {
        const keys = Object.keys(parsed);
        const shown = keys.slice(0, 12).join(', ');
        return `json object, keys: ${shown}${keys.length > 12 ? `, +${keys.length - 12} more` : ''}`;
      }
    } catch { /* not JSON after all; fall through */ }
  }

  // XML-ish covers a lot of MCP output without committing to a parser.
  const tags = trimmed.match(/<([a-zA-Z][\w:.-]*)(?=[\s/>])/g);
  if (tags && tags.length >= 2) {
    const counts = new Map();
    for (const t of tags) {
      const name = t.slice(1);
      counts.set(name, (counts.get(name) || 0) + 1);
    }
    // Sorted by count, then name, so the line is stable for identical input.
    const top = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 8)
      .map(([name, n]) => `${name}×${n}`);
    return `tags: ${top.join(', ')}`;
  }

  const lines = trimmed ? trimmed.split('\n').length : 0;
  return `plain text, ${lines} line(s)`;
}

/**
 * Builds the stub that replaces a tool result on the wire. Head and tail are
 * kept verbatim because the ends of a tool result are where the useful framing
 * usually is, and because a verbatim excerpt cannot hallucinate.
 */
export function digest(artifact, { head = DIGEST_HEAD, tail = DIGEST_TAIL } = {}) {
  const text = artifact.content ?? '';
  const len = text.length;
  const id = artifact.id;
  const name = artifact.tool_name || 'tool';

  if (len <= head + tail) {
    // Nothing to gain; keep it whole rather than emit a stub bigger than its source.
    return text;
  }

  const elided = len - head - tail;
  return [
    `[compacted: artifact ${id} · ${name} · ${len.toLocaleString('en-US')} chars · ${outline(text)}]`,
    text.slice(0, head),
    `\n… ${elided.toLocaleString('en-US')} chars elided …\n`,
    text.slice(len - tail),
    `[Full output retained. Read it with context_expand("${id}", grep=... or offset/limit).]`
  ].join('\n');
}

/** Rough size of the wire payload, for when a provider reports no usage at all. */
export function estimateTokens(wireMessages) {
  let chars = 0;
  for (const m of wireMessages) {
    if (typeof m.content === 'string') chars += m.content.length;
    if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
  }
  return Math.ceil(chars / 4);
}

/**
 * Decides whether this turn should open a new epoch, and what to demote.
 *
 * Returns null when nothing should change -- which is the common case, and the
 * case that keeps the prefix cached. Called once at the start of a turn, never
 * mid-turn, so within a turn the prefix only ever grows.
 */
export function planEpoch(rows, { threshold, keepTurns, promptTokens }) {
  if (!(promptTokens > threshold)) return null;

  // Everything from the Nth-from-last user message onward stays verbatim: the
  // model is most likely to still be working from the recent turns.
  const userSeqs = rows.filter((r) => r.role === 'user').map((r) => r.seq);
  if (userSeqs.length <= keepTurns) return null;
  const boundarySeq = userSeqs[userSeqs.length - keepTurns];

  const targets = rows.filter(
    (r) => r.role === 'tool' && r.artifact_id && !r.stub_text && r.seq < boundarySeq
  );
  // No candidates means bumping the epoch would cost a cache miss for nothing.
  if (!targets.length) return null;

  return { boundarySeq, targets };
}

/**
 * Applies the plan: writes each stub back to the store and records the new
 * boundary. After this returns, the prefix up to `boundarySeq` is frozen --
 * stubs are persisted, so every later rebuild produces identical bytes.
 */
export function applyEpoch(store, chat, plan) {
  let saved = 0;
  for (const row of plan.targets) {
    const artifact = store.getArtifact(row.artifact_id);
    if (!artifact) continue;
    const stub = digest(artifact);
    if (stub.length >= (row.content?.length ?? 0)) continue;
    store.setStub(row.id, stub);
    saved += (row.content?.length ?? 0) - stub.length;
  }
  if (!saved) return null;
  const epoch = chat.epoch + 1;
  store.touchChat(chat.id, { epoch, boundary_seq: plan.boundarySeq });
  return { epoch, boundarySeq: plan.boundarySeq, saved };
}
