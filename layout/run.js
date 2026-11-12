#!/usr/bin/env node
// The page at the sizes people use it at: phones, an editor's preview pane, a
// tablet, laptops. Each page and menu is opened at each size, with the sidebar
// open and collapsed, and checked for what has gone wrong before: something
// hanging past the window's edge, a menu spilling out of its own box, a box the
// browser scrolled although nobody can scroll it back, table headers on top of
// each other, a rail over the transcript. A screenshot of every state lands in
// layout/out/ for what a check cannot see.
//
// Opt-in (`npm run build:web && npm run test:layout`), not part of `npm test`:
// it needs Chrome, and lives outside test/ because `node --test` runs every
// file there. playwright-core drives the installed Chrome, $CHROME_PATH, or
// its own headless shell (`npx playwright-core install chromium-headless-shell`).
//   --size 783x508     only that size (repeatable)
//   --state files      only states whose name contains this (repeatable)
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../', import.meta.url));
const OUT = join(REPO, 'layout', 'out');

/** Real devices and windows, plus the editor pane the trouble was first seen in. */
const SIZES = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'phone landscape', width: 844, height: 390 },
  { name: 'editor pane', width: 783, height: 508 },
  { name: 'tablet landscape', width: 1024, height: 768 },
  { name: 'laptop', width: 1280, height: 720 },
  { name: 'desktop', width: 1440, height: 900 }
];
/** Below this the sidebar is a drawer, so "collapsed" means nothing (stores/ui.ts NARROW). */
const SHELL = 720;
const CHAT_ID = 'layout-long-chat';
const COLLAPSE_KEY = 'tinywebui.side.collapsed';
/** The sidebar's narrowest drag (chat/sidebar/Sidebar.vue SIDE_MIN), remembered under this key. */
const WIDTH_KEY = 'tinywebui.sideWidth';
const SIDE_MIN = 176;

const args = process.argv.slice(2);
const want = (flag) => args.flatMap((a, i) => (a === flag && args[i + 1] ? [args[i + 1]] : []));
const onlySizes = want('--size');
const onlyStates = want('--state');

// ---------- the app, on a database of its own ----------

const ANSWER = (n) => `Here is part ${n}, with the shapes models write.

| Fund | Fee | Domicile | Replication |
|---|---|---|---|
| Example All-World | 0.19% | Ireland | Sampled |
| Example Developed | 0.12% | Ireland | Physical |

\`\`\`ts
export function longLineThatShouldScrollInsideItsOwnBlockRatherThanWidenThePage(argumentNumberOne: string, argumentNumberTwo: number) { return argumentNumberOne.repeat(argumentNumberTwo); }
\`\`\`

A long unbroken link must wrap: https://example.com/a/very/long/path/that/keeps/going/and/going/without/any/spaces/at/all/to/break/on/${'x'.repeat(60)}

${'A paragraph long enough to wrap over several lines at every width, so the measure column is exercised. '.repeat(4)}`;

async function seed(dbPath) {
  const { Store } = await import('../server/store/index.ts');
  const { ALL_USERS } = await import('../server/store/scope.ts');
  const store = new Store(dbPath);
  try {
    store.chats.create({ id: CHAT_ID, title: 'A long chat whose title is long enough to need truncating in the header at narrow widths' });
    for (let n = 1; n <= 6; n++) {
      store.messages.add(CHAT_ID, { role: 'user', content: `Question ${n}: what changed in part ${n}, and how does it compare with the earlier parts?` });
      store.messages.add(CHAT_ID, { role: 'assistant', content: ANSWER(n) });
    }
    for (const name of ['quarterly-report-with-a-long-file-name.txt', 'notes.md', 'data.csv']) {
      store.documents.add(CHAT_ID, { filename: name, mime: 'text/plain', content: `The contents of ${name}.\n`.repeat(20) });
    }
    // Enough chats that the list scrolls, so the last row's menu meets the list's bottom edge.
    const day = 24 * 3600 * 1000;
    for (let i = 1; i <= 16; i++) store.chats.create({ title: `Another chat ${i} with a title long enough to be cut`, createdAt: Date.now() - i * day });
    const filed = store.chats.create({ title: 'A chat in a folder' });
    store.chats.organize(filed.id, { folder: 'Research' }, ALL_USERS);
  } finally { store.close(); }
}

async function startApp() {
  const dir = mkdtempSync(join(tmpdir(), 'tinywebui-layout-'));
  const dbPath = join(dir, 'chats.db');
  await seed(dbPath);
  const { start } = await import('../server/server.ts');
  const srv = await start({
    port: 0, host: '127.0.0.1', configFile: false, mcpServers: {}, dbPath,
    config: {
      authMode: 'local', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'layout-model',
      autoTitle: false, retrieval: { mode: 'lexical' }
    }
  });
  return { srv, dir, base: `http://127.0.0.1:${srv.address().port}` };
}

// ---------- what is checked, in the page ----------

/** Runs in the browser. Returns one line per problem. */
function audit() {
  const vw = innerWidth, vh = innerHeight, out = [];
  const label = (el) => el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') +
    (typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '');
  const shown = (el) => {
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    for (let a = el; a; a = a.parentElement) if (getComputedStyle(a).opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  // Content past a box is fine when something between them clips or scrolls it.
  const held = (el, box, axis) => {
    for (let a = el.parentElement; a && a !== box; a = a.parentElement) {
      if (getComputedStyle(a)[axis === 'x' ? 'overflowX' : 'overflowY'] !== 'visible') return true;
    }
    return false;
  };
  const outermost = (els) => els.filter((el) => !els.includes(el.parentElement));

  if (document.scrollingElement.scrollTop || document.scrollingElement.scrollLeft) out.push('the page itself is scrolled');

  const all = [...document.querySelectorAll('body *')];
  const past = all.filter((el) => {
    const r = el.getBoundingClientRect();
    return r.right > vw + 1 && r.left < vw && shown(el) && !held(el, null, 'x');
  });
  for (const el of outermost(past)) out.push(`past the right edge: ${label(el)} (to ${Math.round(el.getBoundingClientRect().right)}px of ${vw})`);

  for (const el of all) {
    const cs = getComputedStyle(el);
    if (el.scrollTop > 0 && /hidden|clip/.test(cs.overflowY)) out.push(`scrolled though it cannot scroll: ${label(el)} (${Math.round(el.scrollTop)}px down)`);
    if (el.scrollLeft > 0 && /hidden|clip/.test(cs.overflowX)) out.push(`scrolled though it cannot scroll: ${label(el)} (${Math.round(el.scrollLeft)}px across)`);
  }

  for (const box of document.querySelectorAll('.popover, dialog[open]')) {
    if (!shown(box)) continue;
    const r = box.getBoundingClientRect();
    if (r.top < -1 || r.left < -1 || r.bottom > vh + 1 || r.right > vw + 1) {
      out.push(`${label(box)} is not inside the window (${Math.round(r.left)},${Math.round(r.top)} to ${Math.round(r.right)},${Math.round(r.bottom)} in ${vw}×${vh})`);
    }
    const spill = [...box.querySelectorAll('*')].filter((el) => {
      const c = el.getBoundingClientRect();
      return shown(el) && ((c.bottom > r.bottom + 1 && !held(el, box, 'y') && getComputedStyle(box).overflowY === 'visible') ||
        (c.right > r.right + 1 && !held(el, box, 'x') && getComputedStyle(box).overflowX === 'visible'));
    });
    for (const el of outermost(spill)) out.push(`spills out of ${label(box)}: ${label(el)}`);
  }

  for (const row of document.querySelectorAll('thead tr')) {
    const cells = [...row.children].filter(shown);
    for (let i = 1; i < cells.length; i++) {
      if (cells[i - 1].getBoundingClientRect().right > cells[i].getBoundingClientRect().left + 1) out.push(`table headers overlap: "${cells[i - 1].textContent.trim()}" and "${cells[i].textContent.trim()}"`);
    }
    for (const c of cells) if (c.scrollWidth > c.clientWidth + 1 && getComputedStyle(c).textOverflow !== 'ellipsis') out.push(`table header does not fit: "${c.textContent.trim()}"`);
  }

  // A menu's list squeezed to a row or two, scrolling on its own inside the menu.
  for (const list of document.querySelectorAll('.popover .pop-scroll')) {
    if (shown(list) && list.clientHeight + 1 < Math.min(list.scrollHeight, 120)) {
      out.push(`a menu's list is squeezed: ${label(list)} shows ${list.clientHeight}px of ${list.scrollHeight}px`);
    }
  }

  const column = document.querySelector('#log .wrap');
  if (column && shown(column)) {
    const col = column.getBoundingClientRect();
    for (const rail of document.querySelectorAll('.right-rail > *, .outline-rail')) {
      if (!shown(rail)) continue;
      const r = rail.getBoundingClientRect();
      if (r.left < col.right - 1 && r.right > col.left + 1 && r.top < col.bottom && r.bottom > col.top) out.push(`${label(rail)} lies over the transcript`);
    }
  }
  return [...new Set(out)];
}

// ---------- the states, each from a fresh load ----------

const settle = (page) => page.waitForTimeout(250);
/** On a phone the sidebar is a drawer, and on a desktop it may be collapsed: either way #menu brings it out. */
async function showSidebar(page, { narrow, collapsed }) {
  if (narrow || collapsed) { await page.click('#menu'); await settle(page); }
}
async function openSidebarItem(page, shape, selector) {
  await showSidebar(page, shape);
  await page.click(selector);
  await settle(page);
}
async function lastChatMenu(page, shape) {
  await showSidebar(page, shape);
  const last = page.locator('#side .chat-item-wrap').last();
  await last.scrollIntoViewIfNeeded();
  await last.hover();
  await last.locator('.chat-action').click();
}
async function folderMenu(page, shape) {
  await showSidebar(page, shape);
  const heading = page.locator('#side .chat-folder-heading').first();
  await heading.hover();
  await heading.locator('.folder-options').click();
}

/** Each returns false when the state does not exist at this size (nothing is checked then). */
const STATES = [
  { name: 'empty chat', run: async () => true },
  { name: 'empty chat, model menu', run: async (page) => { await page.click('.composer-model'); return true; } },
  { name: 'empty chat, + menu', run: async (page) => { await page.click('.composer-attach'); return true; } },
  { name: 'long chat', path: `/?chat=${CHAT_ID}`, run: async () => true },
  { name: 'long chat, model menu', path: `/?chat=${CHAT_ID}`, run: async (page) => { await page.click('.composer-model'); return true; } },
  { name: 'long chat, + menu', path: `/?chat=${CHAT_ID}`, run: async (page) => { await page.click('.composer-attach'); return true; } },
  {
    name: 'empty chat, library dialog',
    run: async (page) => {
      await page.click('.composer-attach');
      await page.getByText('Attach from earlier chats').click();
      await page.waitForSelector('dialog[open]');
      return true;
    }
  },
  {
    name: 'long chat, delete answer dialog', path: `/?chat=${CHAT_ID}`,
    run: async (page) => {
      const last = page.locator('#log .turn').last();
      await last.hover();
      await page.locator('[aria-label="Delete answer"]').last().click();
      await page.waitForSelector('dialog[open]');
      return true;
    }
  },
  { name: 'last chat menu', run: async (page, shape) => { await lastChatMenu(page, shape); return true; } },
  { name: 'folder menu', run: async (page, shape) => { await folderMenu(page, shape); return true; } },
  {
    name: 'folder dialog',
    run: async (page, shape) => {
      await folderMenu(page, shape);
      await page.getByText('Name and instructions').click();
      await page.waitForSelector('dialog[open]');
      return true;
    }
  },
  // The sidebar dragged as narrow as it goes.
  { name: 'narrow sidebar', narrowSide: true, run: async (page, shape) => !shape.narrow && !shape.collapsed },
  { name: 'narrow sidebar, last chat menu', narrowSide: true, run: async (page, shape) => { if (shape.narrow || shape.collapsed) return false; await lastChatMenu(page, shape); return true; } },
  { name: 'files', run: async (page, shape) => { await openSidebarItem(page, shape, '#toggle-files'); return true; } },
  {
    name: 'file viewer',
    run: async (page, shape) => {
      await openSidebarItem(page, shape, '#toggle-files');
      await page.click('.files-main');
      await page.waitForSelector('dialog.viewer[open]', { timeout: 3000 });
      return true;
    }
  },
  { name: 'mcp', run: async (page, shape) => { await openSidebarItem(page, shape, '#toggle-mcp'); return true; } },
  { name: 'drawer', run: async (page, { narrow }) => { if (!narrow) return false; await page.click('#menu'); return true; } },
  // Every settings section, from the dialog's own rail.
  { name: 'settings', many: true }
];

async function openSettings(page, shape) {
  await openSidebarItem(page, shape, '#account');
  if (await page.locator('#openSettings').isVisible()) await page.click('#openSettings');
  await page.waitForSelector('#settingsDialog[open]');
  await settle(page);
}

// ---------- the run ----------

async function launch() {
  const { chromium } = await import('playwright-core');
  // Last, Playwright's own headless shell (`npx playwright-core install chromium-headless-shell`):
  // WSL has no Chrome, and cannot drive the Windows one over Playwright's pipe.
  const tries = process.env.CHROME_PATH ? [{ executablePath: process.env.CHROME_PATH }] : [{ channel: 'chrome' }, { channel: 'chromium' }, { channel: 'msedge' }, {}];
  for (const opt of tries) {
    try { return await chromium.launch({ headless: true, ...opt }); } catch { /* the next one */ }
  }
  return null;
}

async function main() {
  if (!existsSync(join(REPO, 'dist', 'index.html'))) {
    console.error('layout: dist/ is missing; run `npm run build:web` first.');
    process.exit(1);
  }
  const browser = await launch();
  if (!browser) {
    console.log('layout: SKIPPED, no Chrome found (install Chrome, run `npx playwright-core install chromium-headless-shell`, or set CHROME_PATH to a Chromium build).');
    return;
  }
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const app = await startApp();
  const failures = [];
  let checked = 0;
  try {
    for (const size of SIZES) {
      if (onlySizes.length && !onlySizes.includes(`${size.width}x${size.height}`)) continue;
      const narrow = size.width <= SHELL;
      for (const collapsed of narrow ? [false] : [false, true]) {
        const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height }, reducedMotion: 'reduce' });
        if (collapsed) await ctx.addInitScript(([k]) => localStorage.setItem(k, '1'), [COLLAPSE_KEY]);
        const page = await ctx.newPage();
        page.setDefaultTimeout(5000);
        const shape = { narrow, collapsed };
        const where = `${size.width}×${size.height} (${size.name}${narrow ? '' : collapsed ? ', sidebar collapsed' : ', sidebar open'})`;
        const tag = `${size.width}x${size.height}${collapsed ? '-collapsed' : ''}`;
        const check = async (state) => {
          await settle(page);
          const problems = await page.evaluate(audit);
          checked++;
          await page.screenshot({ path: join(OUT, `${tag}-${state.replace(/[^a-z0-9]+/gi, '-')}.png`) });
          for (const p of problems) failures.push(`${where} · ${state}: ${p}`);
        };
        for (const state of STATES) {
          if (onlyStates.length && !onlyStates.some((s) => state.name.includes(s))) continue;
          await page.evaluate(([k, v]) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch {} }, [WIDTH_KEY, state.narrowSide ? String(SIDE_MIN) : '']).catch(() => {});
          await page.goto(app.base + (state.path || '/'));
          await page.waitForSelector('.composer-model');
          if (state.path) await page.waitForSelector('#log .wrap');
          try {
            if (state.many) {
              await openSettings(page, shape);
              const items = page.locator('#settingsDialog .settings-rail-items .nav-item');
              for (let i = 0; i < await items.count(); i++) {
                const name = (await items.nth(i).innerText()).trim().replace(/\s+\d+$/, '');
                await items.nth(i).click();
                await check(`settings: ${name}`);
              }
              continue;
            }
            if (await state.run(page, shape) === false) continue;
            await check(state.name);
          } catch (err) {
            failures.push(`${where} · ${state.name}: could not open (${String(err.message).split('\n')[0]})`);
          }
        }
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => app.srv.close(resolve));
    rmSync(app.dir, { recursive: true, force: true });
  }
  console.log(`layout: ${checked} states checked; screenshots in ${OUT}`);
  if (failures.length) {
    console.log(`\n${failures.length} problem${failures.length === 1 ? '' : 's'}:\n${failures.map((f) => `  ${f}`).join('\n')}`);
    process.exitCode = 1;
  } else console.log('layout: no problems found');
}

await main();
