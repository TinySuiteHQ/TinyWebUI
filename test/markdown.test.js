// renderMarkdown and markSnippet are the only places the page turns outside
// text into HTML (CLAUDE.md: "no other innerHTML with outside content"), so
// these are injection tests first and rendering tests second.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, markSnippet } from '../public/core/md.js';

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

test('text that contains the stash marker renders as text', () => {
  assert.equal(renderMarkdown('`a` 0 b'), '<p><code>a</code> 0 b</p>');
});

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
  assert.equal(renderMarkdown('- a\n- b'), '<ul><li>a</li><li>b</li></ul>');
  assert.equal(renderMarkdown('```js\n<x>\n```'), '<pre data-lang="js"><code>&lt;x&gt;</code></pre>');
  assert.match(renderMarkdown('| a |\n|---|\n| 1 |'), /<th>a<\/th>.*<td>1<\/td>/s);
  assert.equal(renderMarkdown('see 1 and 2'), '<p>see 1 and 2</p>');
});
