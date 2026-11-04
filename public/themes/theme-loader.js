/*
 * Theme loader — the only bridge between the core app and public/themes/.
 * Skins are pure CSS files that redefine the variables styles.css already
 * reads; this file knows how to list the built-in ones and apply any theme.
 * Adding a skin means dropping a CSS file here and adding one line to
 * manifest.json — nothing in app.js or styles.css changes.
 *
 * Which theme applies (the person's pick, the admin's default, or an
 * imported one) is decided in panels/appearance.js; app.js hands it these
 * functions, so nothing here runs until it is called.
 *
 * A skin may also name a `js` module. That module is the skin's own scenery:
 * it gets mounted when the skin is selected and unmounted when it is not, and
 * it is expected to keep to the same contract the CSS does — decorative,
 * pointer-events:none, nothing that reads or writes app state. The loader is
 * the only place that knows such modules exist, so a skin with one is still
 * just a file in this directory.
 *
 * A theme, as these functions take it: { id, href, js?, scope }. `scope` is
 * what goes on <html data-theme>: a built-in's own id, or "custom" for an
 * imported one, whose rules are all written under that.
 */

const LINK_ID = 'theme-css';
// The theme last applied, so the next load paints it before the server answers.
const APPLIED = 'tinywebui.theme.applied';
// Sign-in off: the one person's pick lives in the browser (the key predates imports).
const CHOICE = 'tinywebui.theme';
// Scenery is a module inside a theme folder, never a path from anywhere else.
const SCENE_PATH = /^[\w-]+\/[\w.-]+\.js$/;

/** The mounted scenery module's teardown, if the current skin brought one. */
let unmountScene = null;
/** The id of the theme on the page now ('' for the plain look), so re-applying it is free. */
let current = null;

/** The built-in themes, from the manifest; none if it can't be read. */
export async function builtInThemes() {
  try {
    const res = await fetch('themes/manifest.json');
    const list = (await res.json()).themes || [];
    return list.map((t) => ({ id: t.id, name: t.name, href: `themes/${t.file}`, js: t.js || null, scope: t.id }));
  } catch { return []; }
}

/** Puts `theme` on the page; null is the plain look. */
export async function applyTheme(theme) {
  const id = theme?.id || '';
  if (id === current) return;
  current = id;
  remember(theme);
  document.documentElement.dataset.theme = theme?.scope || '';

  // Whatever the last skin put on the page goes first, before its CSS does:
  // a scene left running against another skin's palette is the one failure
  // mode this bridge can actually cause.
  if (unmountScene) {
    try { unmountScene(); } catch { /* a broken skin must not wedge the picker */ }
    unmountScene = null;
  }

  let link = document.getElementById(LINK_ID);
  if (!theme) {
    if (link) link.remove();
    return;
  }
  if (!link) {
    link = document.createElement('link');
    link.id = LINK_ID;
    link.rel = 'stylesheet';
    document.head.appendChild(link);
  }
  const loaded = cssLoaded(link, theme.href);
  link.href = theme.href;

  if (!theme.js || !SCENE_PATH.test(theme.js)) return;
  try {
    // The scene reads its palette out of the skin's own custom properties, so
    // it cannot start until that stylesheet is actually applied. Setting href
    // and importing in the same breath loses that race: the module resolves
    // first, every variable reads back empty, and the scene starts against a
    // palette that does not exist yet.
    await loaded;
    const mod = await import(`./${theme.js}`);
    // The skin may have been switched again while its module was loading.
    if (current !== id) return;
    unmountScene = (await mod.mount?.()) || mod.unmount || null;
  } catch (err) {
    // Scenery is decoration — the skin still works as plain CSS — but a failure
    // that leaves no trace anywhere is the one that costs an afternoon.
    console.warn(`[theme] "${id}" scenery did not start:`, err);
  }
}

/** Applies whatever was on the page last time, before anyone has asked the server. */
export function paintLastTheme() {
  let theme = null;
  try { theme = JSON.parse(localStorage.getItem(APPLIED) || 'null'); } catch { /* none, or storage blocked */ }
  if (theme && typeof theme.id === 'string' && typeof theme.href === 'string') applyTheme(theme);
}

/** Sign-in off: the pick kept in this browser; null when there is none. */
export function localChoice() {
  try { return localStorage.getItem(CHOICE); } catch { return null; }
}

export function setLocalChoice(id) {
  try {
    if (id == null) localStorage.removeItem(CHOICE);
    else localStorage.setItem(CHOICE, id);
  } catch { /* per-viewer convenience only */ }
}

function remember(theme) {
  try {
    if (theme) localStorage.setItem(APPLIED, JSON.stringify(theme));
    else localStorage.removeItem(APPLIED);
  } catch { /* first paint just waits for the server */ }
}

/** Resolves when the stylesheet at `href` has applied, or when waiting any
 *  longer stops being worth it. A skin must never hang on its own decoration,
 *  so this resolves rather than rejects on error or timeout. */
function cssLoaded(link, href) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    link.addEventListener('load', finish, { once: true });
    link.addEventListener('error', finish, { once: true });
    // A stylesheet already in the cache can fire load before we listen, and a
    // slow one must not hold the scene hostage.
    setTimeout(finish, 2000);
    queueMicrotask(() => {
      for (const sheet of document.styleSheets) {
        if (sheet.href && sheet.href.endsWith(href)) finish();
      }
    });
  });
}
