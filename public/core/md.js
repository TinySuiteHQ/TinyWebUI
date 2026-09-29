// The page's only producers of HTML from outside text. A small, dependency-free
// Markdown renderer that covers what chat models actually emit -- headings,
// emphasis, code, lists, tables, quotes, links -- and nothing else, plus the
// search-snippet highlighter. Everything is HTML-escaped before any tag is
// produced, so model output can never inject markup.

const esc = (s) => s.replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

// A private-use character: stands in for a stashed span while the inline rules run.
const MARK = '\uE000';

function inline(src) {
  // A MARK typed into the text would otherwise read as a reference to a stash slot.
  let out = esc(src).replaceAll(MARK, '');
  const spans = [];
  const stash = (html) => `${MARK}${spans.push(html) - 1}${MARK}`;

  // Code spans first: nothing inside them should be interpreted further.
  out = out.replace(/`([^`\n]+)`/g, (_, code) => stash(`<code>${code}</code>`));

  // Only http(s)/mailto/anchor/same-site links become anchors; anything else
  // (javascript:, data:, a protocol-relative //host) degrades to its link text.
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_, text, href) =>
    /^(https?:|mailto:|#|\/(?!\/))/i.test(href)
      ? stash(`<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`)
      : text);
  out = out.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, pre, href) =>
    pre + stash(`<a href="${href}" target="_blank" rel="noopener noreferrer">${href}</a>`));

  out = out
    .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, '$1<em>$2</em>')
    .replace(/(^|\W)_([^_\n]+)_(?=\W|$)/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');

  return out.replace(new RegExp(`${MARK}(\\d+)${MARK}`, 'g'), (_, i) => spans[i]);
}

const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

export function renderMarkdown(src) {
  const lines = String(src).replace(/\r\n/g, '\n').split('\n');
  const html = [];
  let i = 0;

  const listBlock = (ordered) => {
    const items = [];
    const marker = ordered ? /^\s*\d+[.)]\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/;
    while (i < lines.length) {
      const m = lines[i].match(marker);
      if (m) { items.push(m[1]); i++; continue; }
      // A wrapped continuation line belongs to the item above it.
      if (items.length && /^\s+\S/.test(lines[i])) {
        items[items.length - 1] += ' ' + lines[i].trim();
        i++;
        continue;
      }
      break;
    }
    const tag = ordered ? 'ol' : 'ul';
    html.push(`<${tag}>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</${tag}>`);
  };

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*```/.test(line)) {
      const lang = line.replace(/^\s*```/, '').trim();
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i++; // closing fence, or the end of a stream still being written
      html.push(`<pre data-lang="${esc(lang)}"><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }

    if (!line.trim()) { i++; continue; }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      html.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
      i++;
      continue;
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) { html.push('<hr>'); i++; continue; }

    if (/^\s*>/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
      html.push(`<blockquote>${renderMarkdown(body.join('\n'))}</blockquote>`);
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) { listBlock(false); continue; }
    if (/^\s*\d+[.)]\s+/.test(line)) { listBlock(true); continue; }

    if (line.includes('|') && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1] || '')) {
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|')) rows.push(cells(lines[i++]));
      html.push(
        `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>` +
        `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`
      );
      continue;
    }

    const para = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(#{1,6}\s|>|```|[-*+]\s|\d+[.)]\s)/.test(lines[i])) {
      para.push(lines[i++]);
    }
    html.push(`<p>${inline(para.join('\n')).replace(/\n/g, '<br>')}</p>`);
  }

  return html.join('\n');
}

/** Turns the search index's ‹...› markers into <mark>, escaping everything else. */
export function markSnippet(raw) {
  return String(raw).split('‹').map((chunk, i) => {
    if (i === 0) return esc(chunk);
    const at = chunk.indexOf('›');
    if (at === -1) return esc('‹' + chunk); // an unmatched marker -- show it plainly rather than eat it
    return `<mark>${esc(chunk.slice(0, at))}</mark>${esc(chunk.slice(at + 1))}`;
  }).join('');
}
