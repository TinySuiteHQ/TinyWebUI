/** The settings panel: model/runtime config, MCP servers, and the tools list. */
import { $, el, num, installLink } from '../core/dom.js';
import { addError } from '../chat/transcript.js';
import { whoami, loadAccess } from '../core/access.js';
import { api } from '../core/api.js';
import { PANEL, closePanel } from './panels.js';
import { initModelEditor, renderCatalog, collectCatalog, setLocked, newConnector, modelPages } from './model-editor.js';
import { renderHome } from './settings-home.js';

/**
 * The tools panel: built-ins first, then every MCP server with its own health
 * and its tools under it. Each tool and each server carries a checkbox --
 * unchecking a tool drops it from what the model is offered; unchecking a
 * server disconnects it outright, which is one fewer live connection rather
 * than just one the model is not shown.
 *
 * Rebuilt wholesale from a fresh /api/tools payload after every toggle, so the
 * panel can never drift from what the server actually did with the request.
 */
// Set from /api/config: a non-admin sees the deployment's settings but
// cannot change them.
let readOnly = false;
export const isReadOnly = () => readOnly;
// The deployment's model as last loaded; the composer's model menu starts from it.
let model = '';
export const configuredModel = () => model;

function renderToolPanel(data) {
  const box = $('tools');
  box.innerHTML = '';
  const mode = data.toolApproval || 'writes';

  const enabled = data.internal.filter((t) => !t.disabled).length
    + data.servers.reduce((n, s) => n + s.tools.filter((t) => !t.disabled).length, 0);
  const total = data.internal.length + data.servers.reduce((n, s) => n + s.tools.length, 0);
  const up = data.servers.filter((s) => s.status === 'ok').length;
  $('toolCount').textContent = total
    ? `${enabled}/${total} enabled · ${up}/${data.servers.length} server${data.servers.length === 1 ? '' : 's'} up`
    : 'none';

  if (data.internal.length) {
    const grp = el('div', 'tool-group');
    const h = el('div', 'tool-group-h');
    h.textContent = 'built-in';
    grp.appendChild(h);
    for (const t of data.internal) grp.appendChild(toolRow(t, mode));
    box.appendChild(grp);
  }
  for (const s of data.servers) box.appendChild(serverGroup(s, mode));

  if (!data.internal.length && !data.servers.length) {
    box.innerHTML = '<div class="empty">no tools</div>';
  }
}

async function toggleTool(name, disabled) {
  try { renderToolPanel(await api.post('/api/tools/toggle', { name, disabled })); } catch (err) { addError(err.message); }
}

async function toggleServer(name, disabled) {
  try { renderToolPanel(await api.post(`/api/mcp/servers/${encodeURIComponent(name)}/toggle`, { disabled })); } catch (err) { return addError(err.message); }
  loadMcp(); // the raw editor's disabled: true/false has to catch up too
}

// A checkbox living inside a <summary> still triggers the details' native
// open/close on click, since that is the browser's default action for the
// element the click landed in, not a listener that stopPropagation alone
// would beat -- so the click itself has to be stopped from ever reaching it.
function checkbox(checked, title, onToggle) {
  const label = el('label', 'tgl');
  const cb = el('input');
  cb.type = 'checkbox';
  cb.checked = checked;
  cb.title = title;
  cb.onclick = (e) => e.stopPropagation();
  cb.onchange = () => { cb.disabled = true; onToggle(!cb.checked); };
  if (readOnly) cb.disabled = true;
  label.appendChild(cb);
  return label;
}

// What "default" resolves to for this tool under the global mode, so the
// select says what will actually happen rather than just "default".
function defaultApproval(t, mode) {
  if (mode === 'off') return 'never';
  if (mode === 'all') return 'ask';
  return t.readOnly === true ? 'never (read-only)' : 'ask (may write)';
}

function approvalSelect(t, mode) {
  const sel = el('select', 'approval');
  sel.title = 'Whether calls to this tool wait for your approval';
  for (const [value, label] of [
    ['default', `approval: ${defaultApproval(t, mode)}`],
    ['ask', 'approval: always ask'],
    ['auto', 'approval: never ask']
  ]) {
    const o = el('option');
    o.value = value;
    o.textContent = label;
    sel.appendChild(o);
  }
  sel.value = t.approval;
  if (readOnly) sel.disabled = true;
  // Same reason as the checkbox: a click in a <summary> toggles the details.
  sel.onclick = (e) => e.stopPropagation();
  sel.onchange = async () => {
    sel.disabled = true;
    try { renderToolPanel(await api.post('/api/tools/approval', { name: t.name, policy: sel.value })); } catch (err) {
      sel.disabled = false;
      addError(err.message);
    }
  };
  return sel;
}

function toolRow(t, mode) {
  const d = el('details', 'tool' + (t.disabled ? ' off' : ''));
  const sum = el('summary');
  sum.appendChild(checkbox(
    !t.disabled,
    t.disabled ? 'Disabled -- click to let the model use this tool again' : 'Click to stop offering this tool to the model',
    (disabled) => toggleTool(t.name, disabled)
  ));
  const name = el('span', 'name');
  name.textContent = t.name.replace(/^[^_]+__/, '');
  const desc = el('span', 'desc');
  desc.textContent = (t.description || '').split('\n')[0];
  sum.append(name, desc);
  // MCP tools only: built-ins never ask, so they have no approval state.
  if (t.approval) sum.appendChild(approvalSelect(t, mode));
  d.append(sum, toolDoc(t));
  return d;
}

/** The expanded part of a tool row: its description, parameters and raw schema. */
function toolDoc(t) {
  const doc = el('div', 'doc');
  doc.textContent = t.description || '(no description)';
  const props = t.parameters?.properties || {};
  const required = new Set(t.parameters?.required || []);
  if (Object.keys(props).length) {
    const list = el('div', 'params');
    for (const [key, spec] of Object.entries(props)) {
      const row = el('div', 'param');
      const b = el('b');
      b.textContent = key;
      const ty = el('span', 'ty');
      ty.textContent = spec.type || (spec.anyOf ? 'any' : '?');
      const req = el('span', required.has(key) ? 'req' : 'ty');
      req.textContent = required.has(key) ? 'required' : 'optional';
      const dd = el('span', 'd');
      dd.textContent = (spec.description || '').split('\n')[0];
      row.append(b, ty, req, dd);
      list.appendChild(row);
    }
    doc.appendChild(list);
  }
  const raw = el('pre');
  raw.textContent = JSON.stringify(t.parameters ?? {}, null, 2);
  doc.appendChild(raw);
  return doc;
}

const SERVER_STATUS_LABEL = { ok: 'connected', disabled: 'disabled', error: 'failed to connect' };

function serverGroup(s, mode) {
  const grp = el('div', `tool-group server ${s.status}`);
  const h = el('div', 'tool-group-h');
  h.appendChild(checkbox(
    s.status !== 'disabled',
    s.status === 'disabled' ? 'Disabled -- click to reconnect' : 'Click to disconnect this server',
    (disabled) => toggleServer(s.name, disabled)
  ));
  const dot = el('span', 'dot');
  const name = el('span', 'name');
  name.textContent = s.name;
  const meta = el('span', 'meta');
  meta.textContent = s.status === 'ok'
    ? `${s.tools.length} tool${s.tools.length === 1 ? '' : 's'}`
    : s.install ? `needs ${s.install.name}` : SERVER_STATUS_LABEL[s.status];
  h.append(dot, name, meta);
  grp.appendChild(h);

  if (s.status === 'error' && s.error) {
    const err = el('div', 'tool-group-err');
    err.textContent = s.error;
    if (s.install) err.append(' ', installLink(s.install));
    grp.appendChild(err);
  }
  if (s.status === 'ok' && s.instructions) {
    const note = el('details', 'tool-group-instructions');
    const sum = el('summary');
    sum.textContent = 'instructions';
    const body = el('div', 'body');
    body.textContent = s.instructions;
    note.append(sum, body);
    grp.appendChild(note);
  }
  if (s.status === 'ok') {
    if (!s.tools.length) {
      const empty = el('div', 'empty');
      empty.textContent = 'no tools';
      grp.appendChild(empty);
    } else {
      for (const t of s.tools) grp.appendChild(toolRow(t, mode));
    }
  }
  return grp;
}

export async function loadTools() {
  let data;
  try { data = await api.get('/api/tools'); } catch (err) {
    $('tools').replaceChildren(Object.assign(el('div', 'empty'), { textContent: `Couldn't load tools (${err.message}).` }));
    return;
  }
  renderToolPanel(data);
}

export async function loadMcp() {
  let out;
  try { out = await api.get('/api/mcp'); } catch (err) {
    $('mcpMsg').textContent = `Couldn't load MCP config (${err.message}).`;
    return;
  }
  const { path, text, locked, readOnly: managed } = out;
  $('mcpText').value = text;
  $('mcpText').readOnly = Boolean(locked);
  $('saveMcp').disabled = Boolean(locked);
  $('mcpPath').textContent = managed ? 'managed by your administrator'
    : locked ? 'set in code (read-only)' : path;
}

/* ---------- pages ----------
 * Settings is a home page (endpoints and their models) and a page per thing
 * opened from it. Every page edits the same unsaved draft, so moving between
 * them loses nothing and one Save writes it all. */

let view = 'home';
// Whether this person edits the deployment's endpoints and catalog.
let admin = false;
let defaultKey = { set: false, hint: '' };
let modelField = null; // the default-model field, moved between its two homes

function showView(name, page) {
  view = name;
  for (const v of document.querySelectorAll('#settings .set-view')) v.hidden = v.dataset.view !== name;
  const current = document.querySelector(`#settings .set-view[data-view="${name}"]`);
  let title = current.dataset.title;
  if (name === 'connector' || name === 'model') {
    $(`${name}Slot`).replaceChildren(page);
    page.refresh?.();
    const s = page.summary();
    title = s.label || s.id || (name === 'model' ? 'New model' : 'New connector');
  }
  if (name === 'home' && admin) renderHome({ open: showView, defaultModel: $('model').value.trim(), defaultKey, defaultModelField: modelField });
  // Off the home card (catalog not empty, or not an admin) the field lives on
  // the defaults page; an admin with a catalog picks the default per model.
  if (!modelField.isConnected || name !== 'home') $('defaultModelGroup').appendChild(modelField);
  $('defaultModelGroup').hidden = admin;
  $('setTitle').textContent = title;
  $('setBack').hidden = name === 'home' || readOnly;
  document.querySelector('#settings .settings-content').scrollTop = 0;
}

/** Esc and Back: one page up, or false when already at the top. */
export function settingsBack() {
  if (view === 'home' || readOnly) return false;
  showView('home');
  return true;
}

export function initSettings() {
  $('saveMcp').onclick = saveMcp;
  $('save').onclick = saveConfig;
  $('testDefault').onclick = testDefault;
  modelField = $('defaultModelField');
  $('setBack').onclick = settingsBack;
  for (const b of document.querySelectorAll('#settings [data-open]')) b.onclick = () => showView(b.dataset.open);
  $('addConnector').onclick = () => showView('connector', newConnector());
  initModelEditor({
    isDefault: (id) => Boolean(id) && $('model').value.trim() === id,
    makeDefault: (id) => { $('model').value = id; },
    renameDefault: (from, to) => { if (from && $('model').value.trim() === from) $('model').value = to; },
    removed: () => showView('home')
  });
}

async function testDefault() {
  const msg = $('testDefaultMsg');
  msg.textContent = 'testing…';
  try {
    const out = await api.post('/api/connectors/test', { id: 'default', baseUrl: $('baseUrl').value.trim(), apiKey: $('apiKey').value });
    msg.textContent = out.ok ? `reachable${out.models != null ? ` · ${out.models} models` : ''}` : out.error || `status ${out.status}`;
  } catch (err) { msg.textContent = err.message; }
}

async function saveMcp() {
  const btn = $('saveMcp');
  btn.disabled = true;
  btn.textContent = 'reconnecting…';
  try {
    const out = await api.post('/api/mcp', { text: $('mcpText').value });
    await loadTools();
    $('mcpMsg').textContent = out.mcpErrors?.length ? out.mcpErrors.join('; ') : 'connected';
    await loadConfig();
  } catch (err) {
    $('mcpMsg').textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'save & reconnect';
  }
}

const FORM_KEYS = ['systemPrompt', 'model', 'temperature', 'maxTokens', 'timezone', 'maxToolRounds', 'askUserTimeoutSeconds', 'cacheTtl',
  'cacheMode', 'compactThreshold', 'keepTurns', 'maxInlineChars', 'maxTurnChars', 'compactMinSaved',
  'maxHistoryTokens', 'toolApproval', 'baseUrl', 'apiKey', 'llmCompaction', 'compactionMaxTokens', 'expandCharBudget',
  'cache', 'reasoningReplay', 'extraBody'];

// The browser's IANA zones, plus whatever the config holds if the browser
// doesn't list it, so a saved value is never silently swapped for another.
function fillTimezones(current) {
  const sel = $('timezone');
  if (sel.options.length === 1) {
    for (const tz of Intl.supportedValuesOf?.('timeZone') ?? []) sel.appendChild(Object.assign(el('option'), { value: tz, textContent: tz }));
  }
  if (current && ![...sel.options].some((o) => o.value === current)) {
    sel.appendChild(Object.assign(el('option'), { value: current, textContent: current }));
  }
}

// Keys the server was started with in code; shown read-only and never posted.
let lockedKeys = new Set();

/** Whether a setting is pinned in code, so the UI cannot change it. */
export const isLocked = (key) => readOnly || lockedKeys.has(key);

export async function loadConfig() {
  let cfg;
  try { cfg = await api.get('/api/config'); } catch (err) {
    // Without the lock list the form can't be edited safely; keep it read-only.
    for (const id of FORM_KEYS) $(id).disabled = true;
    $('save').disabled = true;
    $('saveMsg').textContent = `Couldn't load settings (${err.message}).`;
    return;
  }
  lockedKeys = new Set(cfg.lockedKeys || []);
  readOnly = Boolean(cfg.readOnly);
  const mine = whoami().customize || [];
  $('settings').classList.toggle('prefs-only', readOnly);
  $('myInstructionsGroup').hidden = !mine.includes('instructions');
  $('myInstructions').value = whoami().instructions || '';
  $('themeGroup').hidden = readOnly && !mine.includes('theme');
  $('myPrefsLink').hidden = readOnly ? !mine.length : false;
  for (const id of FORM_KEYS) {
    const locked = readOnly || lockedKeys.has(id);
    $(id).disabled = locked;
    $(id).title = readOnly ? 'managed by your administrator' : locked ? 'set in code' : '';
  }
  $('save').disabled = readOnly ? !mine.includes('instructions') : Boolean(cfg.frozen);
  if (readOnly) $('saveMsg').textContent = mine.length ? '' : 'managed by your administrator';
  else if (cfg.frozen) $('saveMsg').textContent = 'frozen deployment: settings are managed in its files';
  if (cfg.frozen) for (const id of FORM_KEYS) $(id).title = 'frozen deployment: change the config file';
  $('systemPrompt').value = cfg.systemPrompt;
  model = cfg.model;
  $('model').value = cfg.model;
  $('temperature').value = cfg.temperature ?? '';
  $('maxTokens').value = cfg.maxTokens ?? '';
  $('maxToolRounds').value = cfg.maxToolRounds;
  $('askUserTimeoutSeconds').value = cfg.askUserTimeoutSeconds ?? 120;
  $('cacheTtl').value = cfg.cacheTtl ?? '5m';
  $('compactThreshold').value = cfg.compactThreshold ?? 0;
  $('keepTurns').value = cfg.keepTurns ?? 2;
  $('maxInlineChars').value = cfg.maxInlineChars ?? 0;
  $('maxTurnChars').value = cfg.maxTurnChars ?? 0;
  $('compactMinSaved').value = cfg.compactMinSaved ?? 0;
  $('maxHistoryTokens').value = cfg.maxHistoryTokens ?? 0;
  $('cacheMode').value = cfg.cacheMode ?? 'auto';
  fillTimezones(cfg.timezone);
  $('timezone').value = cfg.timezone ?? '';
  $('toolApproval').value = cfg.toolApproval ?? 'writes';
  // The admin block is only sent to (and only meaningful for) the sole user or an admin.
  admin = Boolean(whoami().isAdmin) && !readOnly && cfg.baseUrl !== undefined;
  $('adminConnection').hidden = !admin;
  for (const n of document.querySelectorAll('#settings .admin-only')) n.hidden = !admin;
  if (admin) {
    defaultKey = { set: Boolean(cfg.hasApiKey), hint: cfg.keyHint || '' };
    $('baseUrl').value = cfg.baseUrl ?? '';
    $('apiKey').value = '';
    $('apiKey').placeholder = cfg.hasApiKey ? `set (…${cfg.keyHint || ''}) — blank keeps it` : 'not set';
    $('llmCompaction').value = String(cfg.llmCompaction !== false);
    $('compactionMaxTokens').value = cfg.compactionMaxTokens ?? 8192;
    $('expandCharBudget').value = cfg.expandCharBudget ?? 8000;
    $('cache').value = String(cfg.cache !== false);
    $('reasoningReplay').value = cfg.reasoningReplay ?? 'auto';
    $('extraBody').value = Object.keys(cfg.extraBody || {}).length ? JSON.stringify(cfg.extraBody, null, 2) : '';
    renderCatalog(cfg);
    setLocked(Boolean(cfg.frozen) || lockedKeys.has('models') || lockedKeys.has('connectors'));
    $('addConnector').hidden = Boolean(cfg.frozen) || lockedKeys.has('connectors');
  }
  showView(readOnly ? 'prefs' : 'home');
  saved = draftState();
  // The chip is the model picker's button now; the tool count lives in the
  // + menu, where the tools themselves are.
  // Tier 3 shows your own model; the configured one is only the default.
  const me = whoami();
  const bits = [me.authMode === 'trusted-header' && me.model ? me.modelLabel || me.model : cfg.modelLabel || cfg.model];
  if (!cfg.hasApiKey) bits.push('NO API KEY');
  if (cfg.mcpErrors?.length) bits.push(`${cfg.mcpErrors.length} mcp err`);
  $('status').textContent = bits.join(' · ');
}

/** The config patch the pages currently hold. Throws on bad JSON. */
function buildPatch() {
  const patch = {
    systemPrompt: $('systemPrompt').value,
    model: $('model').value.trim(),
    temperature: num($('temperature').value),
    maxTokens: num($('maxTokens').value),
    maxToolRounds: Number($('maxToolRounds').value) || 12,
    askUserTimeoutSeconds: Math.max(0, Math.round(Number($('askUserTimeoutSeconds').value) || 0)),
    cacheTtl: $('cacheTtl').value,
    compactThreshold: Number($('compactThreshold').value) || 0,
    keepTurns: Number($('keepTurns').value) || 2,
    maxInlineChars: Number($('maxInlineChars').value) || 0,
    maxTurnChars: Number($('maxTurnChars').value) || 0,
    compactMinSaved: Number($('compactMinSaved').value) || 0,
    maxHistoryTokens: Number($('maxHistoryTokens').value) || 0,
    cacheMode: $('cacheMode').value,
    timezone: $('timezone').value,
    toolApproval: $('toolApproval').value
  };
  if (admin) {
    const apiKey = $('apiKey').value;
    Object.assign(patch, {
      baseUrl: $('baseUrl').value.trim(),
      ...(apiKey ? { apiKey } : {}),
      llmCompaction: $('llmCompaction').value === 'true',
      compactionMaxTokens: Number($('compactionMaxTokens').value) || 8192,
      expandCharBudget: Number($('expandCharBudget').value) || 0,
      cache: $('cache').value === 'true',
      reasoningReplay: $('reasoningReplay').value,
      extraBody: $('extraBody').value.trim() ? JSON.parse($('extraBody').value) : {},
      ...collectCatalog()
    });
  }
  for (const k of lockedKeys) delete patch[k];
  return patch;
}

// The draft as of the last load, to tell whether closing would lose edits.
let saved = '';
function draftState() {
  if (readOnly) return $('myInstructions').value;
  try { return JSON.stringify([buildPatch(), $('myInstructions').value]); } catch { return null; }
}

/** Whether closing now would drop unsaved edits; asks, and on yes reloads the saved settings. */
export function settingsCanClose() {
  const now = draftState();
  if (now === saved) return true;
  if (!window.confirm('Discard unsaved settings changes?')) return false;
  loadConfig();
  return true;
}

async function saveConfig() {
  // Personal instructions go to the person's own prefs, whatever else they may edit.
  if (!$('myInstructionsGroup').hidden) {
    try { await api.post('/api/me/prefs', { instructions: $('myInstructions').value.trim() || null }); } catch (err) {
      $('saveMsg').textContent = `save failed (${err.message})`;
      return;
    }
    await loadAccess();
    if (readOnly) { $('saveMsg').textContent = 'saved'; saved = draftState(); closePanel(PANEL.SETTINGS, { force: true }); return; }
  }
  let patch;
  try { patch = buildPatch(); } catch (err) {
    $('saveMsg').textContent = `save failed (${err.message})`;
    return;
  }
  try { await api.post('/api/config', patch); } catch (err) {
    $('saveMsg').textContent = `save failed (${err.message})`;
    return;
  }
  await loadConfig();
  await loadAccess(); // a changed model changes what it can take
  await loadTools(); // the per-tool "default" labels follow the global mode
  $('saveMsg').textContent = 'saved';
  closePanel(PANEL.SETTINGS, { force: true });
}

/** The panel's onOpen: a stale "saved" would read as this visit's. */
export function onSettingsOpen() {
  if (!$('save').disabled) $('saveMsg').textContent = '';
  showView(readOnly ? 'prefs' : 'home');
}

/** The panel's onClose. */
export function onSettingsClose({ swapping }) {
  // A panel swap should leave focus to the panel being opened. Focusing the
  // composer here would otherwise raise the mobile keyboard behind it.
  if (!swapping) $('input').focus();
}
