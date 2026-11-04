/**
 * Settings → My preferences → Appearance: which theme is on, and the themes
 * people import. Built-in themes come from public/themes; imported ones from
 * /api/themes. The admin may set a default for everyone; a role allowed to
 * personalise its theme (access.customize) may pick another and import its own.
 *
 * Applying a theme is the theme loader's job, handed in from app.js.
 */
import { $, el } from '../core/dom.js';
import { api } from '../core/api.js';

// Select values that are not theme ids: an id never starts with ':'.
const FOLLOW = ':default';
const PLAIN = ':plain';

let deps = null;
let builtIn = [];
// /api/themes, or null when it could not be read (offline, signed out).
let state = null;

/** The theme to describe to the loader for an id ('' is the plain look), or null if there is none by that id. */
function themeOf(id) {
  if (id === '') return { id: '' };
  const b = builtIn.find((t) => t.id === id);
  if (b) return b;
  const c = state?.custom.find((t) => t.id === id);
  return c ? { id: c.id, href: `api/themes/${c.id}.css`, js: null, scope: 'custom' } : null;
}

/** The person's own pick: null to follow the default. Sign-in off keeps it in the browser. */
const choice = () => (state?.multiUser ? state.choice : deps.localChoice());

/** The id on the page: their pick if they may have one and it still exists, else the default, else plain. */
function effectiveId() {
  const pick = choice();
  if (state?.canChoose !== false && pick != null && themeOf(pick)) return pick;
  const fallback = state?.default || '';
  return themeOf(fallback) ? fallback : '';
}

function apply() {
  const t = themeOf(effectiveId());
  deps.applyTheme(t && t.id ? t : null);
}

function option(value, text) {
  return Object.assign(el('option'), { value, textContent: text });
}

/** Plain, the built-ins, then imported themes (`which` filters them), as option groups. */
function fill(select, { follow = null, which = () => true } = {}) {
  select.replaceChildren();
  if (follow) select.appendChild(option(FOLLOW, follow));
  const shipped = el('optgroup');
  shipped.label = 'Built-in';
  shipped.appendChild(option(PLAIN, 'TinyWebUI'));
  for (const t of builtIn) shipped.appendChild(option(t.id, t.name));
  select.appendChild(shipped);
  const custom = (state?.custom || []).filter(which);
  if (!custom.length) return;
  const mine = el('optgroup');
  mine.label = 'Custom';
  for (const t of custom) mine.appendChild(option(t.id, state.multiUser && t.shared ? `${t.name} (everyone)` : t.name));
  select.appendChild(mine);
}

const nameOf = (id) => (id === '' ? 'TinyWebUI' : builtIn.find((t) => t.id === id)?.name || state?.custom.find((t) => t.id === id)?.name || 'TinyWebUI');
const toValue = (id) => (id === null ? FOLLOW : id === '' ? PLAIN : id);
const fromValue = (v) => (v === FOLLOW ? null : v === PLAIN ? '' : v);

function render() {
  const canChoose = Boolean(state?.canChoose);
  const setsDefault = Boolean(state?.multiUser && state.canShare);
  $('themeGroup').hidden = !state || !(canChoose || setsDefault);
  if (!state) return;

  $('themePick').hidden = !canChoose;
  if (canChoose) {
    const dflt = themeOf(state.default) ? state.default : '';
    fill($('theme'), { follow: state.multiUser ? `Default (${nameOf(dflt)})` : null });
    const pick = choice();
    $('theme').value = state.multiUser ? toValue(pick != null && themeOf(pick) ? pick : null) : toValue(effectiveId());
  }

  $('themeDefaultPick').hidden = !setsDefault;
  if (setsDefault) {
    // Only themes everyone can see can be everyone's default.
    fill($('defaultTheme'), { which: (t) => t.shared });
    $('defaultTheme').value = toValue(themeOf(state.default) ? state.default : '');
    const locked = deps.isLocked('theme');
    $('defaultTheme').disabled = locked;
    $('defaultTheme').title = locked ? 'set in the config file' : '';
  }

  // Importing is for anyone who could then use the theme: themselves, or (admins) everyone.
  $('themeActions').hidden = !(canChoose || setsDefault);
  $('themeImport').hidden = !(canChoose || setsDefault);
  $('themeShareLabel').hidden = !setsDefault;
  // An admin without a pick of their own can only import for everyone.
  $('themeShare').checked = setsDefault && !canChoose ? true : $('themeShare').checked;
  $('themeShare').disabled = setsDefault && !canChoose;
  renderDelete();
}

/** The imported theme selected (in their own pick, or for an admin without one, the default), when this person may delete it. */
function deletable() {
  if (!state) return null;
  const select = state.canChoose ? $('theme') : $('defaultTheme');
  const t = state.custom.find((x) => x.id === fromValue(select.value));
  return t && (!t.shared || state.canShare) ? t : null;
}

function renderDelete() {
  const t = deletable();
  $('themeDelete').hidden = !t;
  if (t) $('themeDelete').textContent = t.shared && state.multiUser ? `Delete "${t.name}" for everyone` : `Delete "${t.name}"`;
}

function say(text, ok = false) {
  $('themeMsg').textContent = text;
  $('themeMsg').classList.toggle('ok', ok);
}

/** Reads the themes from the server and puts the right one on the page. */
export async function loadThemes() {
  if (!builtIn.length) builtIn = await deps.builtInThemes();
  try { state = await api.get('/api/themes'); } catch { state = null; }
  render();
  apply();
}

async function pick() {
  say('');
  const id = fromValue($('theme').value);
  if (state.multiUser) {
    try { await api.post('/api/me/theme', { theme: id }); } catch (err) { say(err.message); render(); return; }
    state.choice = id;
  } else {
    deps.setLocalChoice(id);
  }
  renderDelete();
  apply();
}

async function pickDefault() {
  say('');
  const id = fromValue($('defaultTheme').value) ?? '';
  try { await api.post('/api/config', { theme: id }); } catch (err) { say(err.message); render(); return; }
  state.default = id;
  render();
  apply();
  say('Default saved.', true);
}

/** The name a theme file gives itself on its first line (the template's), else its file name. */
function themeName(css, filename) {
  const said = css.match(/TinyWebUI theme:\s*([^\n*]+)/)?.[1]?.trim();
  return (said || filename.replace(/\.css$/i, '')).slice(0, 60) || 'My theme';
}

async function importFile() {
  const file = $('themeFile').files?.[0];
  $('themeFile').value = '';
  if (!file) return;
  say('');
  let created;
  try {
    const css = await file.text();
    created = await api.post('/api/themes', { name: themeName(css, file.name), css, shared: $('themeShare').checked });
  } catch (err) { say(err.message); return; }
  await loadThemes();
  // Straight onto the page, for whoever may pick it; an admin's for-everyone import waits to be made the default.
  if (state?.canChoose) {
    $('theme').value = created.id;
    await pick();
  }
  say(`Imported "${created.name}".`, true);
}

async function remove() {
  const t = deletable();
  if (!t) return;
  if (!window.confirm(t.shared && state.multiUser ? `Delete "${t.name}" for everyone? Anyone using it goes back to the default.` : `Delete "${t.name}"?`)) return;
  try { await api.del(`/api/themes/${t.id}`); } catch (err) { say(err.message); return; }
  if (!state.multiUser && deps.localChoice() === t.id) deps.setLocalChoice(null);
  await loadThemes();
  say(`Deleted "${t.name}".`, true);
}

/**
 * `applyTheme`, `builtInThemes`, `localChoice`, `setLocalChoice`: the theme
 * loader's. `isLocked(key)`: whether a config key is pinned, from settings.
 */
export function initAppearance(d) {
  deps = d;
  $('theme').addEventListener('change', pick);
  $('defaultTheme').addEventListener('change', pickDefault);
  $('themeImport').addEventListener('click', () => $('themeFile').click());
  $('themeFile').addEventListener('change', importFile);
  $('themeDelete').addEventListener('click', remove);
}
