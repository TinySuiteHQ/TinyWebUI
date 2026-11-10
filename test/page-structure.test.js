// The page (web/src) depends on itself one way, so a reader -- or an agent --
// can follow every call from its imports, and outside text only ever becomes
// HTML through the renderers that escape it. These checks keep it that way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../', import.meta.url));
const ROOT = join(REPO, 'web', 'src');
// What each area may import besides itself: the first folder under web/src
// (files at its top level are `app`). `shared` is the repo's shared/, which
// the server imports too. The transcript model (model/) is pure and stands alone.
const MAY_USE = {
  shared: [],
  model: ['shared'],
  core: ['shared'],
  ui: [],
  stores: ['core', 'shared', 'model'],
  chat: ['stores', 'core', 'ui', 'shared', 'model'],
  auth: ['stores', 'core', 'ui', 'shared'],
  panels: ['chat', 'stores', 'core', 'ui', 'shared', 'model'],
  app: ['auth', 'chat', 'panels', 'stores', 'core', 'ui', 'shared', 'model']
};

const rel = (abs) => relative(REPO, abs).split(sep).join('/');
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(join(dir, e.name)) : /\.(ts|vue)$/.test(e.name) ? [join(dir, e.name)] : []);
const files = walk(ROOT).map(rel);
const source = Object.fromEntries(files.map((f) => [f, readFileSync(join(REPO, f), 'utf8')]));

function areaOf(f) {
  if (f.startsWith('shared/')) return 'shared';
  const parts = f.replace('web/src/', '').split('/');
  return parts.length === 1 ? 'app' : parts[0];
}
// Static imports, and dynamic ones (`import('./x.vue')`, the pages split off in app/lazy.ts): a lazily
// loaded module is still a dependency, and the one-way rules hold for it too.
const importsOf = (f) => [
  ...source[f].matchAll(/^\s*import\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"](\.{1,2}\/[^'"]+)['"]/gm),
  ...source[f].matchAll(/\bimport\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)
].map(([, spec]) => rel(join(REPO, dirname(f), spec)));

test('the page has modules to check', () => {
  assert.ok(files.length > 30, `only ${files.length} files under web/src`);
});

test('every relative import resolves', () => {
  for (const f of files) for (const target of importsOf(f)) assert.ok(existsSync(join(REPO, target)), `${f} imports missing ${target}`);
});

test('imports go one way between areas', () => {
  for (const f of files) {
    const from = areaOf(f);
    for (const target of importsOf(f)) {
      if (target.endsWith('.css')) continue;
      const to = areaOf(target);
      assert.ok(to === from || MAY_USE[from].includes(to), `${f} imports ${target}: ${from} may not use ${to}`);
    }
  }
});

test('the transcript model and shared/ stay free of Vue and the DOM', () => {
  for (const f of [...files.filter((x) => areaOf(x) === 'model'), ...readdirSync(join(REPO, 'shared')).map((n) => `shared/${n}`)]) {
    const src = source[f] ?? readFileSync(join(REPO, f), 'utf8');
    assert.doesNotMatch(src, /from\s+['"](vue|pinia)['"]/, `${f} imports Vue`);
    assert.doesNotMatch(src, /\b(document|window)\./, `${f} touches the DOM`);
  }
});

test('the page has no import cycles', () => {
  const state = new Map();
  const visit = (f, path) => {
    if (state.get(f) === 'done') return;
    assert.notEqual(state.get(f), 'visiting', `import cycle: ${[...path, f].join(' -> ')}`);
    state.set(f, 'visiting');
    for (const next of importsOf(f)) if (source[next] !== undefined) visit(next, [...path, f]);
    state.set(f, 'done');
  };
  for (const f of files) visit(f, []);
});

test('outside text becomes HTML only through the escaping renderers', () => {
  // renderMarkdown (chat/Markdown.vue) and markSnippet are tested for
  // injection in markdown.test.js; nothing else may produce HTML.
  for (const f of files) {
    assert.doesNotMatch(source[f], /\binnerHTML\b|outerHTML|insertAdjacentHTML/, `${f} writes HTML directly`);
    for (const [, expr] of source[f].matchAll(/v-html="([^"]*)"/g)) {
      const ok = (f === 'web/src/chat/Markdown.vue' && expr === 'html') || /^markSnippet\(/.test(expr);
      assert.ok(ok, `${f}: v-html="${expr}" -- render through chat/Markdown.vue instead`);
    }
  }
});
