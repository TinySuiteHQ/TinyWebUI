/**
 * Themes. Built-in ones are a folder drop under web/public/themes (served at
 * /themes): a CSS file that reassigns the palette, and optionally a scenery
 * module mounted while the theme is on; see web/public/themes/README.md.
 * Imported ones are CSS people upload, kept by the server (/api/themes) and
 * scoped under [data-theme="custom"].
 *
 * Which one is on: the person's own pick, if their role may have one
 * (access.customize 'theme') and it still exists; otherwise the admin's
 * default for everyone; otherwise the plain look. With sign-in off there is
 * one person, and their pick is kept in the browser.
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { api } from '../core/api.ts';

export type ThemeDef = { id: string, name: string, file: string, js?: string };
export type CustomTheme = { id: string, name: string, shared: boolean };
/** GET /api/themes. */
export type ThemesState = {
  default: string,
  /** null: follow the default. Always null with sign-in off (the pick is local). */
  choice: string | null,
  canChoose: boolean,
  canShare: boolean,
  multiUser: boolean,
  custom: CustomTheme[]
};
/** A theme as the loader applies it; `scope` is what goes on <html data-theme>. */
type Applied = { id: string, href: string, js: string | null, scope: string };

const LINK_ID = 'theme-css';
// The theme last applied, so the next load paints it before the server answers.
const APPLIED = 'tinywebui.theme.applied';
// Sign-in off: the one person's pick lives in the browser (the key predates imports).
const CHOICE = 'tinywebui.theme';
// Scenery is a module inside a theme folder, never a path from anywhere else.
const SCENE_PATH = /^[\w-]+\/[\w.-]+\.js$/;
// What a remembered theme may load from: the built-ins or an imported theme's CSS.
const THEME_HREF = /^\/(themes\/[\w-]+\/[\w.-]+\.css|api\/themes\/t-[0-9a-f]{8}\.css)$/;

function readLocal(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeLocal(key: string, value: string | null) {
  try { if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* per-viewer convenience only */ }
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
  /** /api/themes, or null before it is read or when it could not be (signed out, offline). */
  const server = ref<ThemesState | null>(null);
  const localPick = ref(readLocal(CHOICE));
  /** The mounted scenery's teardown, if the current theme brought one. */
  let unmountScene: (() => void) | null = null;
  /** The id on the page now ('' for the plain look), so re-applying it is free. */
  let current: string | null = null;
  /** The manifest read, which load() waits on: a pick of a built-in means nothing until it is known. */
  let builtIns: Promise<void> | null = null;
  const readBuiltIns = () => (builtIns ??= (async () => {
    try { themes.value = (await (await fetch('/themes/manifest.json')).json()).themes || []; } catch { /* no built-ins this session */ }
  })());

  function themeOf(id: string): Applied | null {
    if (id === '') return { id: '', href: '', js: null, scope: '' };
    const b = themes.value.find((t) => t.id === id);
    if (b) return { id: b.id, href: `/themes/${b.file}`, js: b.js || null, scope: b.id };
    const c = server.value?.custom.find((t) => t.id === id);
    return c ? { id: c.id, href: `/api/themes/${c.id}.css`, js: null, scope: 'custom' } : null;
  }

  const exists = (id: string | null): id is string => id != null && themeOf(id) !== null;
  /** The person's own pick: null to follow the default. */
  const choice = computed(() => (server.value?.multiUser ? server.value.choice : localPick.value));
  /** The default for everyone, or plain if it names a theme that is gone. */
  const defaultId = computed(() => (exists(server.value?.default ?? null) ? server.value!.default : ''));
  const effectiveId = computed(() => {
    const pick = choice.value;
    if (server.value?.canChoose !== false && exists(pick)) return pick;
    return defaultId.value;
  });
  const nameOf = (id: string) => (id === '' ? 'TinyWebUI' : themes.value.find((t) => t.id === id)?.name
    || server.value?.custom.find((t) => t.id === id)?.name || 'TinyWebUI');

  async function apply(theme: Applied | null) {
    const id = theme?.id || '';
    if (id === current) return;
    current = id;
    writeLocal(APPLIED, theme?.id ? JSON.stringify(theme) : null);
    document.documentElement.dataset.theme = theme?.scope || '';
    // The last theme's scenery goes first, before its CSS does: a scene left
    // running against another theme's palette is the one failure this causes.
    if (unmountScene) {
      try { unmountScene(); } catch { /* a broken theme must not wedge the picker */ }
      unmountScene = null;
    }
    let link = document.getElementById(LINK_ID) as HTMLLinkElement | null;
    if (!theme?.id) { link?.remove(); return; }
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
      // The scene reads its palette from the theme's custom properties, so it
      // cannot start until that stylesheet has applied.
      await loaded;
      const mod = await import(/* @vite-ignore */ `/themes/${theme.js}`);
      // The theme may have been switched again while its module loaded.
      if (current !== id) return;
      unmountScene = (await mod.mount?.()) || mod.unmount || null;
    } catch (err) {
      // Scenery is decoration -- the theme still works as plain CSS -- but a
      // failure that leaves no trace costs an afternoon.
      console.warn(`[theme] "${id}" scenery did not start:`, err);
    }
  }

  const applyEffective = () => apply(themeOf(effectiveId.value));

  /** Before anyone has signed in: last visit's theme straight away, and the built-in list. load() corrects it. */
  async function init() {
    let last: Partial<Applied> | null = null;
    try { last = JSON.parse(readLocal(APPLIED) || 'null'); } catch { /* none */ }
    if (last && typeof last.id === 'string' && typeof last.href === 'string' && THEME_HREF.test(last.href)) {
      apply({ id: last.id, href: last.href, js: typeof last.js === 'string' ? last.js : null, scope: typeof last.scope === 'string' ? last.scope : last.id });
    }
    await readBuiltIns();
  }

  /** Reads who may pick what from the server and puts the right theme on the page. */
  async function load() {
    const [state] = await Promise.all([api.get('/api/themes').catch(() => null), readBuiltIns()]);
    server.value = state;
    await applyEffective();
  }

  /** The person's own pick: null to follow the default, '' the plain look. Throws with the server's reason. */
  async function pick(id: string | null) {
    if (server.value?.multiUser) {
      await api.post('/api/me/theme', { theme: id });
      server.value.choice = id;
    } else {
      localPick.value = id;
      writeLocal(CHOICE, id);
    }
    await applyEffective();
  }

  /** The admin's default for everyone. */
  async function setDefault(id: string) {
    await api.post('/api/config', { theme: id });
    if (server.value) server.value.default = id;
    await applyEffective();
  }

  /** The name a theme file gives itself on its first line (the template's), else its file name. */
  function nameFromFile(css: string, filename: string): string {
    const said = css.match(/TinyWebUI theme:\s*([^\n*]+)/)?.[1]?.trim();
    return (said || filename.replace(/\.css$/i, '')).slice(0, 60) || 'My theme';
  }

  async function importFile(file: File, shared: boolean): Promise<CustomTheme> {
    const css = await file.text();
    const created: CustomTheme = await api.post('/api/themes', { name: nameFromFile(css, file.name), css, shared });
    await load();
    return created;
  }

  async function remove(id: string) {
    await api.del(`/api/themes/${id}`);
    if (!server.value?.multiUser && localPick.value === id) { localPick.value = null; writeLocal(CHOICE, null); }
    await load();
  }

  return { themes, server, choice, defaultId, effectiveId, exists, nameOf, init, load, pick, setDefault, importFile, remove };
});
