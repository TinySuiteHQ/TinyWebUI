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
 * Where the substantial prose actually sits.
 *
 * A scraped page is mostly navigation, bylines and short boilerplate; the
 * article itself is the handful of long lines among them. A stub that keeps
 * only the ends leaves the model guessing at `offset=` values, which is the
 * expensive failure -- each blind guess costs a whole round and comes back with
 * sidebar links. Listing where the long lines start turns that into one aimed
 * read.
 *
 * Character offsets, not line numbers, because that is what context_expand's
 * `offset` takes. Generic and deterministic, like everything else here: it
 * measures line lengths and nothing else, and never looks at what a tool is.
 */
export const MAP_MIN_LINE = 200;
export const MAP_MAX_ENTRIES = 12;

export function textMap(text) {
  const rows = [];
  let pos = 0;
  for (const line of String(text ?? '').split('\n')) {
    const len = line.trim().length;
    if (len >= MAP_MIN_LINE) rows.push({ pos, len });
    pos += line.length + 1;
  }
  if (!rows.length) return '';

  // Longest first so the densest prose survives the cut, then back into reading
  // order -- the model pages forward, so the list has to read forward too.
  const top = rows.slice().sort((a, b) => b.len - a.len || a.pos - b.pos).slice(0, MAP_MAX_ENTRIES);
  top.sort((a, b) => a.pos - b.pos);
  const omitted = rows.length - top.length;

  return `Long text at offset= ${top.map((r) => `${r.pos} (${r.len} chars)`).join(', ')}`
    + (omitted > 0 ? `, +${omitted} more` : '');
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
  // Only for prose: a JSON or XML outline already names its own structure, and
  // the model greps those by key or tag rather than paging through them.
  const shape = outline(text);
  const map = shape.startsWith('plain text') ? textMap(text) : '';
  return [
    `[compacted: artifact ${id} · ${name} · ${len.toLocaleString('en-US')} chars · ${shape}]`,
    ...(map ? [map] : []),
    text.slice(0, head),
    `\n… ${elided.toLocaleString('en-US')} chars elided …\n`,
    text.slice(len - tail),
    `[Full output retained. Read it with context_expand("${id}", grep=... or offset/limit).]`
  ].join('\n');
}

/** What one image is counted as, in characters of text (about 1.5k tokens). */
export const IMAGE_CHARS = 6000;

/** Rough size of a tool block, so a large MCP toolset isn't mistaken for history. */
export function estimateToolTokens(tools = []) {
  return tools.length ? Math.ceil(JSON.stringify(tools).length / 4) : 0;
}

/** Rough size of the wire payload, for when a provider reports no usage at all. */
export function estimateTokens(wireMessages) {
  let chars = 0;
  for (const m of wireMessages) {
    if (typeof m.content === 'string') chars += m.content.length;
    else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (p.type === 'text') chars += p.text.length;
        // Base64 length says nothing about what an image costs; providers bill
        // a tile-based figure in the low thousands of tokens.
        else if (p.type === 'image_url') chars += IMAGE_CHARS;
      }
    }
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

  // Old images go the same way as old tool output: they are resent in full on
  // every turn, and unlike text nothing ever shrinks them otherwise.
  const targets = rows.filter((r) => r.seq < boundarySeq && (
    (r.role === 'tool' && r.artifact_id && !r.stub_text)
    || (r.images_json && !r.images_dropped)
  ));
  // No candidates means bumping the epoch would cost a cache miss for nothing.
  if (!targets.length) return null;

  return { boundarySeq, targets };
}

/**
 * Applies the plan: writes each stub back to the store and records the new
 * boundary. After this returns, the prefix up to `boundarySeq` is frozen --
 * stubs are persisted, so every later rebuild produces identical bytes.
 */
export function applyEpoch(store, chat, plan, { minSaved = 0 } = {}) {
  // Stubs are worked out before anything is written: an epoch costs a full
  // cache miss, so one that would only shave a few hundred characters is not
  // worth opening, and the check has to happen before the store is touched.
  const stubs = [];
  let saved = 0;
  const drops = [];
  for (const row of plan.targets) {
    if (row.role !== 'tool') {
      drops.push(row.id);
      saved += JSON.parse(row.images_json).length * IMAGE_CHARS;
      continue;
    }
    const artifact = store.getArtifact(row.artifact_id, chat.id);
    if (!artifact) continue;
    const stub = digest(artifact);
    if (stub.length >= (row.content?.length ?? 0)) continue;
    stubs.push([row.id, stub]);
    saved += (row.content?.length ?? 0) - stub.length;
  }
  if (!saved || saved < minSaved) return null;
  for (const [id, stub] of stubs) store.setStub(id, stub);
  for (const id of drops) store.dropImages(id);
  const epoch = chat.epoch + 1;
  store.touchChat(chat.id, { epoch, boundary_seq: plan.boundarySeq });
  return { epoch, boundarySeq: plan.boundarySeq, saved };
}

/**
 * The hard window: what happens when stubbing is not enough.
 *
 * Compaction only ever shrinks tool output and images, so a long conversation
 * of plain text has nothing to give back and would grow until the provider
 * refuses it outright. Past `maxTokens` the oldest turns leave the wire
 * entirely. The cut always lands on a user message, so no tool call is ever
 * separated from its result, and it moves back far enough to bring the history
 * down to `targetTokens` -- a big step taken rarely, since every move is a full
 * cache miss, the same trade an epoch makes. The last `keepTurns` turns are
 * never cut, whatever they cost.
 *
 * Returns the new first visible seq, or null to leave the window where it is.
 * `rows` must already be what the model would see (window applied, stubs in).
 */
export function planWindow(rows, { maxTokens, targetTokens, keepTurns, toWire }) {
  if (!(maxTokens > 0)) return null;
  const sizes = rows.map((r) => estimateTokens([toWire(r)]));
  let total = sizes.reduce((a, b) => a + b, 0);
  if (total <= maxTokens) return null;

  const userIdx = rows.map((r, i) => (r.role === 'user' ? i : -1)).filter((i) => i >= 0);
  if (userIdx.length <= keepTurns) return null;
  const lastCut = userIdx[userIdx.length - keepTurns];

  let cut = 0;
  for (const i of userIdx) {
    if (i === 0) continue;
    if (i > lastCut) break;
    for (let k = cut; k < i; k++) total -= sizes[k];
    cut = i;
    if (total <= targetTokens) break;
  }
  return cut > 0 ? rows[cut].seq : null;
}

/**
 * Applies a window to stored rows: drops what is before it and marks the
 * first remaining message so the model knows the conversation did not start
 * there. Pure and deterministic, so every rebuild sends the same bytes.
 */
export function windowRows(rows, windowSeq) {
  if (!(windowSeq >= 0)) return rows;
  const kept = rows.filter((r) => r.seq >= windowSeq);
  const dropped = rows.length - kept.length;
  if (!dropped || !kept.length || kept[0].role !== 'user') return kept;
  const note = `[Earlier conversation omitted: ${dropped} message${dropped === 1 ? '' : 's'} before this`
    + ' point were removed to keep the conversation within the context window. If something'
    + ' from before is needed and is not restated here, ask the user.]';
  return [{ ...kept[0], content: `${note}\n\n${kept[0].content ?? ''}` }, ...kept.slice(1)];
}
