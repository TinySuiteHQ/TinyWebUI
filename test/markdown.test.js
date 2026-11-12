// renderMarkdown and markSnippet are the only places the page turns outside
// text into HTML (CLAUDE.md: "no other innerHTML with outside content"), so
// these are injection tests first and rendering tests second.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, renderBlocks, markSnippet } from '../web/src/core/md.ts';

// No tag the renderer does not make itself, and no attribute outside a quoted value.
const OWN_TAGS = new Set(['p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'blockquote', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'mark']);
function assertInert(html, input) {
  for (const [, tag] of html.matchAll(/<\/?([a-zA-Z0-9]+)/g)) {
    assert.ok(OWN_TAGS.has(tag.toLowerCase()), `<${tag}> leaked from ${JSON.stringify(input)}: ${html}`);
  }
  for (const [tag] of html.matchAll(/<[a-zA-Z][^>]*>/g)) {
    assert.doesNotMatch(tag, /\son[a-z]+\s*=/i, `event handler in ${tag} from ${JSON.stringify(input)}`);
  }
  for (const [, href] of html.matchAll(/href="([^"]*)"/g)) {
    assert.match(href, /^(https?:|mailto:|#|\/(?!\/))/i, `unsafe href ${href} from ${JSON.stringify(input)}`);
  }
}

const ATTACKS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '**<svg onload=alert(1)>**',
  '[click](javascript:alert(1))',
  '[click](JaVaScRiPt:alert(1))',
  '[click](data:text/html,<script>alert(1)</script>)',
  '[click](//evil.example/x)',
  '[click](https://a.example/"onmouseover="alert(1))',
  '[x"><img src=x onerror=alert(1)>](https://a.example)',
  'https://a.example/"><img src=x onerror=alert(1)>',
  '```"><script>alert(1)</script>\ncode\n```',
  '# <iframe src=x>',
  '> <b onclick=x>quoted</b>',
  '- <a href=javascript:x>item</a>',
  '| a | <img src=x> |\n|---|---|\n| <script> | b |',
  '`<script>`',
  '0 and 9' // the renderer's own stash markers, typed in
];

test('renderMarkdown never lets markup, handlers or unsafe links through', () => {
  for (const input of ATTACKS) assertInert(renderMarkdown(input), input);
});

test('a private-use character typed into the text renders as text', () => {
  assert.equal(renderMarkdown('`a` 0 b'), '<p><code>a</code> 0 b</p>');
});

// marked puts a newline between block tags; what is drawn is the same either way.
const flat = (html) => html.replace(/>\s+</g, '><');

test('markSnippet escapes everything but its own <mark>', () => {
  for (const input of ATTACKS) assertInert(markSnippet(input), input);
  assert.equal(markSnippet('a ‹<b>› c'), 'a <mark>&lt;b&gt;</mark> c');
});

test('markSnippet shows an unmatched marker instead of dropping it', () => {
  assert.equal(markSnippet('x ‹y'), 'x ‹y');
});

test('renderMarkdown renders what models emit', () => {
  assert.equal(renderMarkdown('**b** *i* `c` ~~d~~'), '<p><strong>b</strong> <em>i</em> <code>c</code> <del>d</del></p>');
  assert.equal(renderMarkdown('[x](https://a.example)'),
    '<p><a href="https://a.example" target="_blank" rel="noopener noreferrer">x</a></p>');
  assert.equal(renderMarkdown('## T'), '<h2>T</h2>');
  assert.equal(flat(renderMarkdown('- a\n- b')), '<ul><li>a</li><li>b</li></ul>');
  assert.equal(renderMarkdown('```js\n<x>\n```'), '<pre data-lang="js"><code>&lt;x&gt;</code></pre>');
  assert.match(renderMarkdown('| a |\n|---|\n| 1 |'), /<th>a<\/th>.*<td>1<\/td>/s);
  assert.equal(renderMarkdown('see 1 and 2'), '<p>see 1 and 2</p>');
});

test('a block has no newlines between its tags, and code keeps its own', () => {
  // Each newline between tags was a blank text node: a third of a long answer's DOM.
  assert.equal(renderMarkdown('- a\n- b'), '<ul><li>a</li><li>b</li></ul>');
  assert.doesNotMatch(renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |'), />\n+</);
  assert.equal(renderMarkdown('```\nx >\n< y\n\n</z>\n```'), '<pre data-lang=""><code>x &gt;\n&lt; y\n\n&lt;/z&gt;</code></pre>');
  assert.equal(renderMarkdown('**a**\n*b*'), '<p><strong>a</strong><br><em>b</em></p>', 'a line break in text is a <br>, not a newline');
});

test('lines that matched a block but not its reading never hang the page', () => {
  // Each of these once sent the renderer round the same line forever.
  // Up to three spaces before a # is still a heading (CommonMark).
  assert.equal(renderMarkdown('  # indented'), '<h1>indented</h1>');
  assert.equal(flat(renderMarkdown('- a\r')), '<ul><li>a</li></ul>', 'a stream cut between the \r and \n of a CRLF');
  assert.equal(renderMarkdown('# title\rnext'), '<h1>title</h1>\n<p>next</p>');
  // A U+2028 inside a line stays part of it.
  assert.equal(flat(renderMarkdown('- a\u2028b')), '<ul><li>a\u2028b</li></ul>');
  assert.match(renderMarkdown('# a\u2028b'), /a\u2028b/, 'rendered, whatever block it reads as');
});

test('lists as models write them: loose, nested, and numbered past 1', () => {
  // The answer that rendered as two lists, each "1.", with its sub-points run into the text.
  const answer = '1. **Types**: how they relate.\n\n2. **Indexing**: fields needed, including:\n   - Core metadata\n   - Location metadata\n\nThe goal is retrieval.';
  const html = flat(renderMarkdown(answer));
  assert.equal(html.match(/<ol/g)?.length, 1, 'one list, not two');
  assert.equal(html.match(/<li>/g)?.length, 4, 'two items and two sub-items');
  assert.match(html, /<li><p><strong>Indexing<\/strong>: fields needed, including:<\/p><ul><li>Core metadata<\/li><li>Location metadata<\/li><\/ul><\/li>/);
  assert.match(flat(renderMarkdown('3. c\n4. d')), /^<ol start="3">/);
});

test('block by block, a streaming answer renders as the whole would, reusing what is finished', () => {
  const answer = '# Plan\n\nFirst **step** here.\n\n- one\n- two\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> said\n\nDone.';
  const cache = new Map();
  for (let n = 0; n <= answer.length; n++) {
    const text = answer.slice(0, n);
    assert.equal(renderBlocks(text, cache).join('\n'), renderMarkdown(text), `after ${n} characters`);
  }
  // The cache holds the blocks of the text last rendered, nothing older.
  assert.equal(cache.size, renderBlocks(answer, cache).length);
  const parts = renderBlocks(answer, cache);
  assert.equal(parts.length, 7, 'heading, paragraph, list, code, table, quote, paragraph');
  assert.equal(parts[3], '<pre data-lang="js"><code>const a = 1;\n\nconst b = 2;</code></pre>', 'a blank line inside a fence stays in it');
  for (const attack of ATTACKS) for (const part of renderBlocks(attack, new Map())) assertInert(part, attack);
});

test('read again only from its end, a growing answer still renders as the whole would', () => {
  // Lists, a lazy continuation, a setext heading and a reference link defined late: what appending can reach back into.
  const answer = '1. **Types**: how they relate.\n\n2. **Indexing**: fields, including:\n   - Core\n   - Location\nstill item two\n\nTitle\n=====\n\nSee [the doc][d].\n\n```\nopen fence\n\n[d]: https://a.example/doc\n';
  const cache = new Map();
  for (let n = 0; n <= answer.length; n++) {
    const text = answer.slice(0, n);
    assert.equal(renderBlocks(text, cache).join('\n'), renderMarkdown(text), `after ${n} characters`);
  }
});
