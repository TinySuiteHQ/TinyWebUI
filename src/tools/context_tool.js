/**
 * expand_context -- the restore half of compaction.
 *
 * Dropping content from the window is only safe if something in what remains
 * can bring it back. Every compacted tool result keeps its artifact id, and
 * this tool reads the stored text by that id.
 *
 * It is deliberately built on grep-and-window semantics rather than on semantic
 * search: the artifact is an opaque blob from an arbitrary MCP server, so there
 * is no schema to rank against and no safe assumption about what "relevant"
 * means. Line matching and byte offsets work on anything, are deterministic,
 * and cost nothing to run. Expansions are appended like any other tool result,
 * so they never disturb the cached prefix.
 */

export const EXPAND_CONTEXT = 'expand_context';
// The name this tool had until 2026-09. Compaction stubs already stored in
// chats tell the model to call it, and stubs are sent verbatim, so the old
// name keeps working -- it is just no longer offered.
export const EXPAND_CONTEXT_LEGACY = 'context_expand';

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
 * Character offsets, not line numbers, because that is what expand_context's
 * `offset` takes. Generic and deterministic: it measures line lengths and
 * nothing else, and never looks at what a tool is.
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

export function expandToolDef() {
  return {
    type: 'function',
    function: {
      name: EXPAND_CONTEXT,
      description: [
        'Read the full text of an earlier tool result that was compacted out of the',
        'conversation. Compacted results appear as "[compacted: artifact <id> ...]" and',
        'show only their first and last few hundred characters.',
        '',
        'Use grep to find the part you need (case-insensitive regular expression, matched',
        'per line), or offset/limit to page through the text. With neither, returns the',
        'beginning. Output is capped, so prefer a specific grep over paging.'
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          artifact_id: {
            type: 'string',
            description: 'The id shown in the compacted marker, e.g. "a1b2c3d4".'
          },
          grep: {
            type: 'string',
            description:
              'Case-insensitive regular expression. Returns matching lines with surrounding context.'
          },
          context_lines: {
            type: 'integer',
            description: 'Lines of context to show around each grep match. Default 2.'
          },
          offset: {
            type: 'integer',
            description: 'Character offset to start reading from. Ignored when grep is given.'
          },
          limit: {
            type: 'integer',
            description: 'Maximum characters to return. Capped by the server budget.'
          }
        },
        required: ['artifact_id']
      }
    }
  };
}

function header(artifact, note) {
  return `[artifact ${artifact.id} · ${artifact.tool_name} · ${artifact.char_len.toLocaleString('en-US')} chars · ${note}]`;
}

function grepView(text, pattern, contextLines, budget, artifact) {
  let re;
  try {
    re = new RegExp(pattern, 'i');
  } catch (err) {
    return `Error: invalid regular expression ${JSON.stringify(pattern)}: ${err.message}`;
  }

  const lines = text.split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) hits.push(i);
  if (!hits.length) {
    // A bare "no match" costs a full round and returns nothing to act on, so the
    // miss carries the same offset map the stub does: the next call can aim at
    // real text instead of guessing another pattern.
    const map = textMap(text);
    return [
      header(artifact, `no match for /${pattern}/i`),
      map || 'No long text blocks -- this artifact is short lines throughout.',
      'Try a broader pattern, or read a window with offset/limit.'
    ].join('\n');
  }

  // Merge overlapping context windows so a dense run of matches prints once.
  const ranges = [];
  for (const i of hits) {
    const from = Math.max(0, i - contextLines);
    const to = Math.min(lines.length - 1, i + contextLines);
    const last = ranges[ranges.length - 1];
    if (last && from <= last.to + 1) last.to = Math.max(last.to, to);
    else ranges.push({ from, to });
  }

  const out = [header(artifact, `${hits.length} line(s) match /${pattern}/i`)];
  let used = out[0].length;
  let shown = 0;
  for (const r of ranges) {
    const block = lines
      .slice(r.from, r.to + 1)
      .map((l, k) => `${String(r.from + k + 1).padStart(6)}│${l}`)
      .join('\n');
    if (used + block.length > budget) {
      out.push(`… ${ranges.length - shown} more match group(s) omitted; narrow the pattern.`);
      break;
    }
    out.push(block);
    used += block.length + 2;
    shown++;
  }
  return out.join('\n\n');
}

function windowView(text, offset, limit, budget, artifact) {
  const start = Math.max(0, Math.min(offset, text.length));
  const size = Math.min(limit > 0 ? limit : budget, budget);
  const slice = text.slice(start, start + size);
  const end = start + slice.length;
  const note = `chars ${start.toLocaleString('en-US')}–${end.toLocaleString('en-US')}`;
  const more = end < text.length
    ? `\n[… ${(text.length - end).toLocaleString('en-US')} chars remain; continue with offset=${end}.]`
    : '';
  return `${header(artifact, note)}\n${slice}${more}`;
}

/** Runs one expansion. Returns a string, like every other tool result. */
export function callExpand(args, { store, chatId, budget = 8000 }) {
  const id = String(args?.artifact_id || '').trim();
  if (!id) return 'Error: artifact_id is required.';

  // Scoped to the conversation that produced it at the query level: artifact ids
  // are short, and one chat must not be able to read another's tool output by guessing.
  const artifact = store.messages.getArtifact(id, chatId);
  if (!artifact) return `Error: no artifact "${id}". Ids appear in the "[compacted: artifact <id> ...]" marker.`;

  if (args.grep) {
    const ctx = Number.isInteger(args.context_lines) ? Math.max(0, Math.min(args.context_lines, 20)) : 2;
    return grepView(artifact.content, String(args.grep), ctx, budget, artifact);
  }
  return windowView(artifact.content, Number(args.offset) || 0, Number(args.limit) || 0, budget, artifact);
}
