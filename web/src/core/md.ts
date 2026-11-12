// The page's only producers of HTML from outside text, and the only HTML that
// may reach v-html (chat/Markdown.vue, and the sidebar's search snippets).
//
// Markdown is read by marked (CommonMark and GFM: loose and nested lists,
// numbered lists that start past 1, tables, task lists), because a hand-rolled
// reader kept meeting list shapes models write all the time. marked does not
// sanitise, so its output is held to the old rule here instead: raw HTML in
// the text is shown as text, never parsed; only http(s), mailto, anchor and
// same-site links become anchors; images become links (the CSP would block an
// outside image anyway). Text and code are escaped by marked and by the
// renderers below. test/markdown.test.js is the injection suite that keeps it so.
import { Marked, type Token, type Tokens, type TokensList } from 'marked';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => (
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]
));

const SAFE_HREF = /^(https?:|mailto:|#|\/(?!\/))/i;
const anchor = (href: string, inner: string) => `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`;

const marked = new Marked({
  gfm: true,
  // A single newline is a line break: chat models write lines, not reflowed prose.
  breaks: true,
  renderer: {
    // Raw HTML, block or inline, is text. Nothing a model writes becomes markup.
    html({ text }: Tokens.HTML | Tokens.Tag) { return esc(text); },
    link({ href, tokens }: Tokens.Link) {
      const inner = this.parser.parseInline(tokens);
      return SAFE_HREF.test(href) ? anchor(href, inner) : inner;
    },
    image({ href, text }: Tokens.Image) {
      const label = esc(text || href);
      return SAFE_HREF.test(href) ? anchor(href, label) : label;
    },
    code({ text, lang }: Tokens.Code) {
      return `<pre data-lang="${esc((lang || '').trim())}"><code>${esc(text)}</code></pre>`;
    }
  }
});

type Links = TokensList['links'];
type Lexed = { text: string, tokens: Token[], links: Links };
/** What each cache's text was last read as, so a streaming answer is read again only from its end. */
const lexed = new WeakMap<Map<string, string>, Lexed>();
/** Blocks read again at the end of a grown text: appending can still change the last ones (a list item, a setext underline). */
const REREAD = 2;

/**
 * The top-level blocks of the text, as marked reads them, blank space dropped.
 * When the text only grew since `cache` last saw it, the blocks before its
 * last few are kept and only the rest is read again: reading the whole answer
 * every frame cost several times what the old hand-rolled reader did.
 */
function blocks(src: unknown, cache: Map<string, string>): { tokens: Token[], links: Links } {
  // A lone \r is a line break too: a stream can be cut between the \r and \n of a CRLF.
  const text = String(src ?? '').replace(/\r\n?/g, '\n');
  const prev = lexed.get(cache);
  let reused: Lexed | null = null;
  // Counted in blocks, not blank space: "1. a", a blank line, then "2" becomes one list once the "." arrives.
  let cut = prev ? prev.tokens.length : 0;
  for (let seen = 0; prev && cut > 0 && seen < REREAD;) if (prev.tokens[--cut].type !== 'space') seen++;
  if (prev && cut > 0 && text.startsWith(prev.text)) {
    const keep = prev.tokens.slice(0, cut);
    const head = keep.map((t) => t.raw).join('');
    // Only where the kept blocks spell out the start of the text exactly; otherwise read it all.
    if (text.startsWith(head)) {
      const tail = marked.lexer(text.slice(head.length));
      reused = { text, tokens: [...keep, ...tail], links: { ...prev.links, ...tail.links } };
    }
  }
  const next: Lexed = reused ?? (() => { const all = marked.lexer(text); return { text, tokens: [...all], links: all.links }; })();
  lexed.set(cache, next);
  return { tokens: next.tokens.filter((t) => t.type !== 'space'), links: next.links };
}

function renderToken(token: Token, links: Links): string {
  // The parser looks up reference-style links ([x][1]) on the list it is given.
  // marked puts a newline after every block tag (</li>\n<li>); each would be a
  // blank text node, a third of a long answer's DOM. Text and code are escaped,
  // so a > and < with only newlines between them are always two tags.
  return marked.parser(Object.assign([token], { links })).trim().replace(/>\n+</g, '><');
}

export function renderMarkdown(src: unknown): string {
  return renderBlocks(src, new Map()).join('\n');
}

/**
 * The text as HTML, one string per top-level block, reusing `cache` for every
 * block already rendered (keyed by its type and source) and replacing its
 * contents with this text's blocks. While an answer streams only its last
 * block changes, so only that one is rendered again, and Markdown.vue leaves
 * the DOM of the finished ones alone.
 */
export function renderBlocks(src: unknown, cache: Map<string, string>): string[] {
  const { tokens, links } = blocks(src, cache);
  const seen = new Map<string, string>();
  const out = tokens.map((token) => {
    const key = `${token.type}\n${token.raw}`;
    const html = seen.get(key) ?? cache.get(key) ?? renderToken(token, links);
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
