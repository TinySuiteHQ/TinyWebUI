// How the page answers to size: @media is for the device and the shell around
// the content (the drawer below 720px, phone and touch sizes below 640px);
// everything that depends on how much room the content has is an @container
// query on its page's host. Window breakpoints went wrong beside the sidebar,
// which takes 256px: a 780px window left the chat narrower than a phone's while
// it still got the desktop layout. These checks keep the split.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../', import.meta.url));
const ROOT = join(REPO, 'web', 'src');

/** The shell's breakpoint (drawer instead of sidebar) and the phone's (tap targets, the menu sheet). */
const SHELL = '(max-width: 720px)';
const PHONE = '(max-width: 640px)';
/** Content widths a container query may use: narrow, compact, the Files table, and the chat's two rails beside --measure. */
const CONTAINER_WIDTHS = ['480px', '640px', '700px', '54rem', '76rem'];
/** What a width @media may style: the shell, and dialogs that go full screen on a phone. */
const SHELL_SELECTOR = /^(#shell|#side|#menu|body|html|input|textarea|select|footer|main \.panel-head|dialog#settingsDialog|\.settings-(frame|rail)|dialog\.viewer|\.viewer-nav)\b/;
/** The elements a page lays out in, each `container-type: inline-size`. */
const HOSTS = ['main', '.settings-body', '#mcp', '#files'];

const rel = (abs) => relative(REPO, abs).split(sep).join('/');
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(join(dir, e.name)) : /\.(css|vue)$/.test(e.name) ? [join(dir, e.name)] : []);
const css = Object.fromEntries(walk(ROOT).map((f) => {
  const text = readFileSync(f, 'utf8');
  const styles = f.endsWith('.vue') ? [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n') : text;
  // Comments go, their line breaks stay, so a problem's line number is the file's.
  return [rel(f), styles.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ''))];
}).filter(([, text]) => text.trim()));

/** Every at-rule of a kind, with its prelude, line and the selectors of the rules directly inside. */
function atRules(text, kind) {
  const out = [];
  const re = new RegExp(`@${kind}\\s*([^{]*)\\{`, 'g');
  let m;
  while ((m = re.exec(text))) {
    let i = m.index + m[0].length, depth = 1, start = i;
    const selectors = [];
    for (; i < text.length && depth; i++) {
      if (text[i] === '{') { if (depth === 1) selectors.push(...text.slice(start, i).split(',').map((s) => s.trim()).filter(Boolean)); depth++; }
      else if (text[i] === '}') { depth--; start = i + 1; }
    }
    out.push({ prelude: m[1].trim(), line: text.slice(0, m.index).split('\n').length, selectors });
  }
  return out;
}

test('a width or height @media is the shell or the phone, and styles only the shell', () => {
  const problems = [];
  for (const [file, text] of Object.entries(css)) {
    for (const { prelude, line, selectors } of atRules(text, 'media')) {
      if (!/width|height/.test(prelude)) continue;
      const touch = /pointer:\s*coarse/.test(prelude);
      const sizes = prelude.split(',').map((q) => q.trim()).filter((q) => !/pointer:\s*coarse/.test(q));
      for (const q of sizes) {
        if (q !== SHELL && q !== PHONE) problems.push(`${file}:${line}: @media ${q}: only ${SHELL} (shell) or ${PHONE} (phone)`);
      }
      // Tap targets grow on any touch screen, wherever they are; that block styles what it must.
      if (touch) continue;
      for (const s of selectors) {
        if (!SHELL_SELECTOR.test(s)) problems.push(`${file}:${line}: "${s}" is laid out by the window; lay it out by its page with @container`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('container queries use the named widths', () => {
  const problems = [];
  for (const [file, text] of Object.entries(css)) {
    for (const { prelude, line } of atRules(text, 'container')) {
      for (const [, width] of prelude.matchAll(/(?:max|min)-width:\s*([\d.]+(?:px|rem))/g)) {
        if (!CONTAINER_WIDTHS.includes(width)) problems.push(`${file}:${line}: @container ${prelude}: use one of ${CONTAINER_WIDTHS.join(', ')}`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('every page host is a size container', () => {
  const all = Object.values(css).join('\n');
  for (const host of HOSTS) {
    const esc = host.replace(/[.#]/g, (c) => `\\${c}`);
    const rules = [...all.matchAll(new RegExp(`(?:^|[},])\\s*([^{}]*?(?:^|,|\\s)${esc}\\s*(?:,[^{]*)?)\\{([^}]*)\\}`, 'gm'))]
      .filter(([, sel]) => sel.split(',').map((s) => s.trim()).includes(host));
    assert.ok(rules.some(([, , body]) => /container-type:\s*inline-size/.test(body)), `${host} needs container-type: inline-size`);
  }
});

test('the breakpoints the page reads in code match the stylesheet', () => {
  const ui = readFileSync(join(ROOT, 'stores', 'ui.ts'), 'utf8');
  assert.match(ui, /NARROW = '\(max-width: 720px\)'/, 'stores/ui.ts NARROW is the shell breakpoint');
  const popover = readFileSync(join(ROOT, 'ui', 'Popover.vue'), 'utf8');
  assert.match(popover, /matchMedia\('\(max-width: 640px\)'\)/, 'ui/Popover.vue SHEET is the phone breakpoint');
  for (const f of walk(ROOT).filter((x) => /\.(ts|vue)$/.test(x))) {
    for (const [, q] of readFileSync(f, 'utf8').matchAll(/['"`](\((?:max|min)-width:[^'"`]*\))['"`]/g)) {
      assert.ok(q === SHELL || q === PHONE, `${rel(f)}: ${q} is neither ${SHELL} nor ${PHONE}`);
    }
  }
});

test('the shell clips rather than hides: a hidden box can still be scrolled by the browser', () => {
  const base = css['web/src/styles/base.css'];
  const shell = [...base.matchAll(/(?:^|})\s*#shell\s*\{([^}]*)\}/g)].map((m) => m[1]).join(';');
  assert.ok(shell, '#shell rule found');
  assert.doesNotMatch(shell, /overflow:\s*hidden/);
});
