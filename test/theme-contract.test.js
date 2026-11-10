// Themes are a folder drop that styles the app by its ids and class names
// (web/public/themes/README.md, "What a theme may rely on"). Nothing ties a
// theme's selectors to the page, so a renamed class would quietly unstyle it;
// this checks every id and class a shipped theme targets still exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../', import.meta.url));
const THEMES = join(REPO, 'web', 'public', 'themes');
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);

// Markup and scripts only: a rule in the app's own stylesheet does not make
// an element exist, and a stale one would otherwise keep a dead name alive.
const page = [join(REPO, 'web', 'index.html'), ...walk(join(REPO, 'web', 'src')).filter((f) => /\.(vue|ts)$/.test(f))]
  .map((f) => readFileSync(f, 'utf8')).join('\n');
const themeJs = walk(THEMES).filter((f) => f.endsWith('.js')).map((f) => readFileSync(f, 'utf8')).join('\n');
const present = (name, src) => new RegExp(`(?<![\\w-])${name.replace(/[-]/g, '\\-')}(?![\\w-])`).test(src);

/** The ids and classes in a stylesheet's selectors (not its values or urls). */
function selectorNames(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@import[^;]*;/g, '').replace(/url\([^)]*\)/g, '');
  const names = new Set();
  for (const [, selector] of clean.matchAll(/([^{}]+)\{/g)) {
    if (selector.trim().startsWith('@')) continue;
    for (const [, name] of selector.replace(/\[[^\]]*\]/g, '').matchAll(/[.#](-?[a-zA-Z_][\w-]*)/g)) names.add(name);
  }
  return names;
}

const sheets = walk(THEMES).filter((f) => f.endsWith('.css'));

test('there are themes to check', () => assert.ok(sheets.length >= 2));

for (const sheet of sheets) {
  const name = sheet.slice(THEMES.length + 1);
  test(`${name} targets only ids and classes the page has`, () => {
    // A theme may style elements its own script adds (scene layers and the like).
    const missing = [...selectorNames(readFileSync(sheet, 'utf8'))].filter((n) => !present(n, page) && !present(n, themeJs));
    assert.deepEqual(missing, [], `${name} styles names the page no longer has`);
  });
}
