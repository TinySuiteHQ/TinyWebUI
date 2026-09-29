// The page's modules are wired in one place (public/app.js) and depend on each
// other one way, so a reader -- or an agent -- can follow every call from its
// imports. These checks keep it that way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../public/', import.meta.url));
const AREAS = ['core', 'chat', 'panels', 'shared'];
// What each area may import besides itself.
const MAY_USE = { core: ['shared'], chat: ['core', 'shared'], panels: ['chat', 'core', 'shared'], shared: [] };

const rel = (abs) => relative(ROOT, abs).split(sep).join('/');
const modules = [
  'app.js',
  ...AREAS.flatMap((area) => readdirSync(join(ROOT, area)).filter((f) => f.endsWith('.js')).map((f) => `${area}/${f}`))
];
const source = Object.fromEntries(modules.map((m) => [m, readFileSync(join(ROOT, m), 'utf8')]));
const importsOf = (m) => [...source[m].matchAll(/\bfrom\s+['"](\.{1,2}\/[^'"]+)['"]/g)]
  .map(([, spec]) => rel(join(ROOT, dirname(m), spec)));
const areaOf = (m) => (m.includes('/') ? m.split('/')[0] : 'app');

test('no page module is imported only for its side effects', () => {
  for (const m of modules) {
    const bare = source[m].match(/^import\s+['"][^'"]+['"]/m);
    assert.equal(bare, null, `${m}: "${bare?.[0]}" -- export an init and call it from app.js`);
  }
});

test('only app.js wires listeners or timers at import time', () => {
  // Top-level (unindented) statements that act on the page rather than define something.
  const wiring = /^(\$\(|document\.|window\.|setInterval|setTimeout|\(function|[A-Za-z_$][\w$]*\.(addEventListener|on[a-z]+\s*=)|[A-Za-z_$][\w$]*\()/;
  for (const m of modules.filter((x) => x !== 'app.js')) {
    source[m].split(/\r?\n/).forEach((line, i) => {
      assert.ok(!wiring.test(line), `${m}:${i + 1} runs on import: ${line.trim()} -- move it into the module's init`);
    });
  }
});

test('imports go one way: panels -> chat -> core -> shared', () => {
  for (const m of modules.filter((x) => x !== 'app.js')) {
    const from = areaOf(m);
    for (const target of importsOf(m)) {
      const to = areaOf(target);
      assert.ok(to === from || MAY_USE[from].includes(to), `${m} imports ${target}: ${from}/ may not use ${to}/`);
    }
  }
});

test('the page has no import cycles', () => {
  const state = new Map(); // module -> 'visiting' | 'done'
  const visit = (m, path) => {
    if (state.get(m) === 'done') return;
    assert.notEqual(state.get(m), 'visiting', `import cycle: ${[...path, m].join(' -> ')}`);
    state.set(m, 'visiting');
    for (const next of importsOf(m)) if (source[next] !== undefined) visit(next, [...path, m]);
    state.set(m, 'done');
  };
  for (const m of modules) visit(m, []);
});

test('every relative import resolves to a page module', () => {
  for (const m of modules) {
    for (const target of importsOf(m)) assert.ok(target in source, `${m} imports missing ${target}`);
  }
});
