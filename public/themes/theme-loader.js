/*
 * Theme loader — the only bridge between the core app and public/themes/.
 * Skins are pure CSS files that redefine the variables styles.css already
 * reads; this file just knows how to list them, apply one, and remember the
 * choice. Adding a skin means dropping a CSS file here and adding one line
 * to manifest.json — nothing in app.js or styles.css changes.
 *
 * A skin may also name a `js` module. That module is the skin's own scenery:
 * it gets mounted when the skin is selected and unmounted when it is not, and
 * it is expected to keep to the same contract the CSS does — decorative,
 * pointer-events:none, nothing that reads or writes app state. The loader is
 * the only place that knows such modules exist, so a skin with one is still
 * just a file in this directory.
 */

const KEY = 'tinywebui.theme';
const LINK_ID = 'theme-css';

/** The mounted scenery module's teardown, if the current skin brought one. */
let unmountScene = null;

async function applyTheme(id, themes) {
  document.documentElement.dataset.theme = id || '';

  // Whatever the last skin put on the page goes first, before its CSS does:
  // a scene left running against another skin's palette is the one failure
  // mode this bridge can actually cause.
  if (unmountScene) {
    try { unmountScene(); } catch { /* a broken skin must not wedge the picker */ }
    unmountScene = null;
  }

  let link = document.getElementById(LINK_ID);
  const t = themes.find((x) => x.id === id);
  if (!t) {
    if (link) link.remove();
    return;
  }
  if (!link) {
    link = document.createElement('link');
    link.id = LINK_ID;
    link.rel = 'stylesheet';
    document.head.appendChild(link);
  }
  const loaded = cssLoaded(link, `themes/${t.file}`);
  link.href = `themes/${t.file}`;

  if (!t.js) return;
  try {
    // The scene reads its palette out of the skin's own custom properties, so
    // it cannot start until that stylesheet is actually applied. Setting href
    // and importing in the same breath loses that race: the module resolves
    // first, every variable reads back empty, and the scene starts against a
    // palette that does not exist yet.
    await loaded;
    const mod = await import(`./${t.js}`);
    // The skin may have been switched again while its module was loading.
    if (document.documentElement.dataset.theme !== id) return;
    unmountScene = (await mod.mount?.()) || mod.unmount || null;
  } catch (err) {
    // Scenery is decoration — the skin still works as plain CSS — but a failure
    // that leaves no trace anywhere is the one that costs an afternoon.
    console.warn(`[theme] "${id}" scenery did not start:`, err);
  }
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

function savedTheme() {
  try { return localStorage.getItem(KEY) || ''; } catch { return ''; }
}

function saveTheme(id) {
  try {
    if (id) localStorage.setItem(KEY, id);
    else localStorage.removeItem(KEY);
  } catch { /* per-viewer convenience only */ }
}

async function init() {
  let themes = [];
  try {
    const res = await fetch('themes/manifest.json');
    themes = (await res.json()).themes || [];
  } catch { /* no manifest, no skins available this session */ }

  const current = savedTheme();
  applyTheme(current, themes);

  const select = document.getElementById('theme');
  if (!select) return;
  for (const t of themes) {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.name;
    select.appendChild(opt);
  }
  select.value = current;
  select.addEventListener('change', () => {
    saveTheme(select.value);
    applyTheme(select.value, themes);
  });
}

init();
