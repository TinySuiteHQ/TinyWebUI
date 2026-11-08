/**
 * Themes are a folder drop under web/public/themes (served at /themes): a CSS
 * file that reassigns the palette, and optionally a scenery module mounted
 * while the theme is selected. This is the only code that knows they exist;
 * see web/public/themes/README.md.
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';

export type ThemeDef = { id: string, name: string, file: string, js?: string };

const KEY = 'tinywebui.theme';
const LINK_ID = 'theme-css';

function saved(): string {
  try { return localStorage.getItem(KEY) || ''; } catch { return ''; }
}

/** Resolves once the stylesheet has applied, or when waiting longer stops being worth it. */
function cssLoaded(link: HTMLLinkElement, href: string): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    link.addEventListener('load', finish, { once: true });
    link.addEventListener('error', finish, { once: true });
    // A cached stylesheet can fire load before we listen; a slow one must not hold the scene hostage.
    setTimeout(finish, 2000);
    queueMicrotask(() => {
      for (const sheet of document.styleSheets) if (sheet.href?.endsWith(href)) finish();
    });
  });
}

export const useTheme = defineStore('theme', () => {
  const themes = ref<ThemeDef[]>([]);
  const current = ref(saved());
  /** The mounted scenery's teardown, if the current theme brought one. */
  let unmountScene: (() => void) | null = null;

  async function apply(id: string) {
    document.documentElement.dataset.theme = id || '';
    // The last theme's scenery goes first, before its CSS does: a scene left
    // running against another theme's palette is the one failure this causes.
    if (unmountScene) {
      try { unmountScene(); } catch { /* a broken theme must not wedge the picker */ }
      unmountScene = null;
    }
    let link = document.getElementById(LINK_ID) as HTMLLinkElement | null;
    const t = themes.value.find((x) => x.id === id);
    if (!t) { link?.remove(); return; }
    if (!link) {
      link = document.createElement('link');
      link.id = LINK_ID;
      link.rel = 'stylesheet';
      document.head.appendChild(link);
    }
    const href = `/themes/${t.file}`;
    const loaded = cssLoaded(link, href);
    link.href = href;
    if (!t.js) return;
    try {
      // The scene reads its palette from the theme's custom properties, so it
      // cannot start until that stylesheet has applied.
      await loaded;
      const mod = await import(/* @vite-ignore */ `/themes/${t.js}`);
      // The theme may have been switched again while its module loaded.
      if (document.documentElement.dataset.theme !== id) return;
      unmountScene = (await mod.mount?.()) || mod.unmount || null;
    } catch (err) {
      // Scenery is decoration -- the theme still works as plain CSS -- but a
      // failure that leaves no trace costs an afternoon.
      console.warn(`[theme] "${id}" scenery did not start:`, err);
    }
  }

  async function init() {
    try { themes.value = (await (await fetch('/themes/manifest.json')).json()).themes || []; } catch { /* no themes this session */ }
    await apply(current.value);
  }

  function set(id: string) {
    current.value = id;
    try { if (id) localStorage.setItem(KEY, id); else localStorage.removeItem(KEY); } catch { /* per-viewer only */ }
    apply(id);
  }

  return { themes, current, init, set };
});
