// The page's only producers of HTML from outside text, and the only HTML that
// may reach v-html (chat/Markdown.vue, and the sidebar's search snippets). A small, dependency-free
// Markdown renderer that covers what chat models actually emit -- headings,
// emphasis, code, lists, tables, quotes, links -- and nothing else, plus the
// search-snippet highlighter. Everything is HTML-escaped before any tag is
// produced, so model output can never inject markup.

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => (
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]
));

// A private-use character: stands in for a stashed span while the inline rules run.
const MARK = '\uE000';

function inline(src: string): string {
  // A MARK typed into the text would otherwise read as a reference to a stash slot.
  let out = esc(src).replaceAll(MARK, '');
  const spans: string[] = [];
  const stash = (html: string) => `${MARK}${spans.push(html) - 1}${MARK}`;

  // Code spans first: nothing inside them should be interpreted further.
  out = out.replace(/`([^`\n]+)`/g, (_, code: string) => stash(`<code>${code}</code>`));

  // Only http(s)/mailto/anchor/same-site links become anchors; anything else
  // (javascript:, data:, a protocol-relative //host) degrades to its link text.
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_, text: string, href: string) =>
    /^(https?:|mailto:|#|\/(?!\/))/i.test(href)
      ? stash(`<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`)
      : text);
  out = out.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, pre: string, href: string) =>
    pre + stash(`<a href="${href}" target="_blank" rel="noopener noreferrer">${href}</a>`));

  out = out
    .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, '$1<em>$2</em>')
    .replace(/(^|\W)_([^_\n]+)_(?=\W|$)/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');

  return out.replace(new RegExp(`${MARK}(\\d+)${MARK}`, 'g'), (_, i: string) => spans[Number(i)]);
}

const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

/**
 * One top-level block and the lines it was read from. The kind and lines are
 * all its HTML depends on: no block reads another, which is what lets a
 * streaming answer render only the block still being written (renderBlocks).
 */
type Block = { kind: 'code' | 'heading' | 'hr' | 'quote' | 'ul' | 'ol' | 'table' | 'para', lines: string[] };

/** Splits the text into its top-level blocks, without rendering anything (cheap: no inline rules run). */
function scan(src: unknown): Block[] {
  // A lone \r is a line break too: a stream can be cut between the \r and \n of a CRLF, and a line left
  // ending in \r matched a block's test but not the rule that reads it (`.` stops at \r), which hung the page.
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  const take = (kind: Block['kind'], from: number) => blocks.push({ kind, lines: lines.slice(from, i) });

  const listBlock = (ordered: boolean) => {
    const from = i;
    const marker = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/;
    while (i < lines.length) {
      if (marker.test(lines[i])) { i++; continue; }
      // A wrapped continuation line belongs to the item above it.
      if (i > from && /^\s+\S/.test(lines[i])) { i++; continue; }
      break;
    }
    take(ordered ? 'ol' : 'ul', from);
  };

  while (i < lines.length) {
    const line = lines[i];
    const from = i;

    if (/^\s*```/.test(line)) {
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) i++;
      i = Math.min(i + 1, lines.length); // the closing fence, or the end of a stream still being written
      take('code', from);
      continue;
    }

    if (!line.trim()) { i++; continue; }

    if (/^(#{1,6})\s+(.*)$/s.test(line)) { i++; take('heading', from); continue; }

    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) { i++; take('hr', from); continue; }

    if (/^\s*>/.test(line)) {
      while (i < lines.length && /^\s*>/.test(lines[i])) i++;
      take('quote', from);
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) { listBlock(false); continue; }
    if (/^\s*\d+[.)]\s+/.test(line)) { listBlock(true); continue; }

    if (line.includes('|') && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1] || '')) {
      i += 2;
      while (i < lines.length && lines[i].includes('|')) i++;
      take('table', from);
      continue;
    }

    while (i < lines.length && lines[i].trim() && !/^\s*(#{1,6}\s|>|```|[-*+]\s|\d+[.)]\s)/.test(lines[i])) i++;
    // A line no rule above took that still stops a paragraph (an indented "  # x") is a paragraph of its own;
    // without this the loop made no progress on it and the page hung.
    if (i === from) i++;
    take('para', from);
  }
  return blocks;
}

function renderBlock({ kind, lines }: Block): string {
  switch (kind) {
    case 'code': {
      const closed = lines.length > 1 && /^\s*```/.test(lines[lines.length - 1]);
      const lang = lines[0].replace(/^\s*```/, '').trim();
      return `<pre data-lang="${esc(lang)}"><code>${esc(lines.slice(1, closed ? -1 : undefined).join('\n'))}</code></pre>`;
    }
    case 'heading': {
      // `s`: a U+2028 in the text is part of the line, as scan() saw it; scan() matched this line.
      const [, hashes, text] = lines[0].match(/^(#{1,6})\s+(.*)$/s) as RegExpMatchArray;
      return `<h${hashes.length}>${inline(text)}</h${hashes.length}>`;
    }
    case 'hr': return '<hr>';
    case 'quote': return `<blockquote>${renderMarkdown(lines.map((l) => l.replace(/^\s*>\s?/, '')).join('\n'))}</blockquote>`;
    case 'ul':
    case 'ol': {
      // `s`, as above: every line scan() took as an item must read as one here.
      const marker = kind === 'ol' ? /^\s*\d+[.)]\s+(.*)$/s : /^\s*[-*+]\s+(.*)$/s;
      const items: string[] = [];
      for (const line of lines) {
        const m = line.match(marker);
        if (m) items.push(m[1]);
        else items[items.length - 1] += ' ' + line.trim();
      }
      return `<${kind}>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</${kind}>`;
    }
    case 'table': {
      const [head, , ...rows] = lines.map(cells);
      return `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>` +
        `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    }
    case 'para': return `<p>${inline(lines.join('\n')).replace(/\n/g, '<br>')}</p>`;
  }
}

export function renderMarkdown(src: unknown): string {
  return scan(src).map(renderBlock).join('\n');
}

/**
 * The text as HTML, one string per top-level block, reusing `cache` for every
 * block already rendered (keyed by its kind and lines) and replacing its
 * contents with this text's blocks. While an answer streams only its last
 * block changes, so only that one runs the inline rules again: the cost of a
 * frame no longer grows with everything written before it.
 */
export function renderBlocks(src: unknown, cache: Map<string, string>): string[] {
  const seen = new Map<string, string>();
  const out = scan(src).map((block) => {
    const key = `${block.kind}\n${block.lines.join('\n')}`;
    const html = seen.get(key) ?? cache.get(key) ?? renderBlock(block);
    seen.set(key, html);
    return html;
  });
  cache.clear();
  for (const [k, v] of seen) cache.set(k, v);
  return out;
}

/** Turns the search index's ‹...› markers into <mark>, escaping everything else. */
export function markSnippet(raw: unknown): string {
  return String(raw).split('‹').map((chunk, i) => {
    if (i === 0) return esc(chunk);
    const at = chunk.indexOf('›');
    if (at === -1) return esc('‹' + chunk); // an unmatched marker -- show it plainly rather than eat it
    return `<mark>${esc(chunk.slice(0, at))}</mark>${esc(chunk.slice(at + 1))}`;
  }).join('');
}
