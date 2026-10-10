/**
 * The admin's draft of the connectors (endpoint + key) and the model catalog,
 * and the editor page for one of each. Every entry is an editor element kept
 * in memory, so its fields are the draft: switching pages detaches it, saving
 * reads them all back. Keys are write-only: an editor shows whether one is set
 * (and its last four characters), and a blank key field means "keep it".
 */
import { $, el } from '../core/dom.js';
import { api } from '../core/api.js';

const TAGS = ['vision', 'reasoning', 'tools'];

/**
 * The settings a model may override, as fields. Each one inherits the global
 * value of the same id (on the "Defaults for all models" page) while blank;
 * select options are copied from that global select.
 */
const OVERRIDES = [
  { key: 'systemPrompt', section: 'Prompt', label: 'System prompt', type: 'textarea', note: 'Replaces the default prompt for this model.' },
  { key: 'temperature', section: 'Sampling', label: 'Temperature', type: 'number', attrs: { step: 0.1, min: 0, max: 2 } },
  { key: 'maxTokens', section: 'Sampling', label: 'Max output tokens', type: 'number', attrs: { min: 1 } },
  { key: 'maxToolRounds', section: 'Tools', label: 'Max tool turns', type: 'number', attrs: { min: 1, max: 50 }, note: 'Tool calls allowed per reply.' },
  { key: 'cacheMode', section: 'Caching', label: 'Cache style', type: 'select' },
  { key: 'cacheTtl', section: 'Caching', label: 'Prompt cache lifetime', type: 'select' },
  { key: 'reasoningReplay', section: 'Advanced', label: 'Replay past reasoning', type: 'select' },
  { key: 'extraBody', section: 'Advanced', label: 'Extra request body (JSON)', type: 'json', note: 'Merged over the default body.' }
];
const SECTIONS = ['Prompt', 'Sampling', 'Tools', 'Caching', 'Advanced'];

const connectorEditors = [];
const modelEditors = [];
let locked = false;

function field(label, input, note) {
  const wrap = el('div');
  const l = el('label');
  l.textContent = label;
  wrap.append(l, input);
  if (note) wrap.appendChild(Object.assign(el('small'), { textContent: note }));
  return wrap;
}

const span2 = (node) => { node.classList.add('span-2'); return node; };
const textInput = (value, placeholder) => Object.assign(el('input'), { value: value ?? '', placeholder: placeholder || '', spellcheck: false });

function group(title, note, ...children) {
  const g = el('section', 'set-group');
  const h = el('header');
  h.appendChild(Object.assign(el('h3'), { textContent: title }));
  if (note) h.appendChild(Object.assign(el('p'), { textContent: note }));
  g.append(h, ...children);
  return g;
}

function grid(...children) {
  const g = el('div', 'set-grid');
  g.append(...children);
  return g;
}

/* ---------- connectors ---------- */

function connectorEditor(c = {}, { onRemove, onRename }) {
  const id = textInput(c.id, 'local');
  // An id is what models name; renaming a saved one would orphan them.
  if (c.id) id.readOnly = true;
  let lastId = c.id || '';
  id.addEventListener('change', () => { onRename(lastId, id.value.trim()); lastId = id.value.trim(); });
  const label = textInput(c.label, 'Local models');
  const url = textInput(c.baseUrl, 'http://localhost:11434/v1');
  const key = Object.assign(textInput('', c.hasApiKey ? `set (…${c.keyHint || ''}) — blank keeps it` : 'none'), { type: 'password', autocomplete: 'off' });
  const clear = Object.assign(el('input'), { type: 'checkbox' });
  const test = Object.assign(el('button'), { type: 'button', textContent: 'Test connection' });
  const msg = el('span', 'usage');
  test.onclick = async () => {
    msg.textContent = 'testing…';
    try {
      const out = await api.post('/api/connectors/test', { id: id.value.trim(), baseUrl: url.value.trim(), apiKey: key.value });
      msg.textContent = out.ok ? `reachable${out.models != null ? ` · ${out.models} models` : ''}` : out.error || `status ${out.status}`;
    } catch (err) { msg.textContent = err.message; }
  };
  const clearLabel = el('label', 'inline-check');
  clearLabel.append(clear, ' remove stored key');
  const remove = Object.assign(el('button'), { type: 'button', textContent: 'Remove connector', className: 'danger' });
  const actions = el('div', 'cfg-actions span-2');
  actions.append(test, msg);

  const page = el('div');
  page.append(
    group('Connector', 'An extra endpoint with its own URL and key. Models pick it by id.', grid(
      field('Id', id, 'What a model names in its connector field.'),
      field('Label', label),
      span2(field('API URL', url)),
      span2(field('API key', key, 'Write-only. Blank keeps the current key.')),
      ...(c.hasApiKey ? [span2(clearLabel)] : []),
      actions
    )),
    el('div', 'set-foot')
  );
  page.lastChild.appendChild(remove);
  remove.onclick = () => onRemove(page);
  page.read = () => ({
    id: id.value.trim(),
    ...(label.value.trim() ? { label: label.value.trim() } : {}),
    baseUrl: url.value.trim(),
    // undefined keeps the stored key on the server; null clears it.
    ...(key.value ? { apiKey: key.value } : clear.checked ? { apiKey: null } : {})
  });
  page.summary = () => ({ id: id.value.trim(), label: label.value.trim(), baseUrl: url.value.trim(), hasKey: Boolean(key.value || (c.hasApiKey && !clear.checked)) });
  return page;
}

/* ---------- models ---------- */

function overrideInput(spec, value) {
  if (spec.type === 'select') {
    const sel = el('select');
    for (const o of $(spec.key).options) sel.appendChild(Object.assign(el('option'), { value: o.value, textContent: o.textContent }));
    sel.prepend(Object.assign(el('option'), { value: '', textContent: 'Inherit' }));
    sel.value = value ?? '';
    // A value this page has no option for (set in the file) must survive a save.
    if (value != null && sel.value !== value) {
      sel.appendChild(Object.assign(el('option'), { value, textContent: value }));
      sel.value = value;
    }
    return sel;
  }
  if (spec.type === 'textarea' || spec.type === 'json') {
    const ta = Object.assign(el('textarea'), { rows: spec.type === 'json' ? 4 : 6, spellcheck: spec.type !== 'json', className: spec.type === 'json' ? 'mono' : '' });
    ta.value = value == null ? '' : spec.type === 'json' ? JSON.stringify(value, null, 2) : value;
    return ta;
  }
  const input = Object.assign(el('input'), { type: 'number', value: value ?? '' });
  for (const [k, v] of Object.entries(spec.attrs || {})) input.setAttribute(k, v);
  return input;
}

// What a blank override falls back to, read off the global field each time
// the page is shown, so an edit on the defaults page is reflected at once.
function inheritHint(spec, input) {
  const global = $(spec.key);
  if (spec.type === 'select') {
    input.options[0].textContent = `Inherit (${global.selectedOptions[0]?.textContent || global.value})`;
    return;
  }
  const v = global.value.trim();
  input.placeholder = spec.key === 'systemPrompt' ? (v ? `Inherit the default prompt: ${v.slice(0, 120)}${v.length > 120 ? '…' : ''}` : 'Inherit (no default prompt)')
    : spec.type === 'json' ? `Inherit: ${v || '{}'}`
    : `Inherit: ${v || global.placeholder || 'provider default'}`;
}

function readOverride(spec, input, name) {
  const raw = input.value.trim();
  if (raw === '') return undefined;
  if (spec.type === 'number') return Number(raw);
  if (spec.type === 'json') {
    let v;
    try { v = JSON.parse(raw); } catch (err) { throw new Error(`model "${name}" ${spec.label}: ${err.message}`); }
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`model "${name}" ${spec.label} must be a JSON object`);
    return v;
  }
  return spec.key === 'systemPrompt' ? input.value : raw;
}

function connectorChoices(sel, current) {
  const ids = connectorEditors.map((c) => c.summary().id).filter(Boolean);
  sel.replaceChildren(Object.assign(el('option'), { value: '', textContent: 'Default endpoint' }),
    ...[...new Set([...ids, ...(current && !ids.includes(current) ? [current] : [])])].map((cid) => Object.assign(el('option'), { value: cid, textContent: cid })));
  sel.value = current || '';
}

function modelEditor(m = {}, { onRemove, isDefault, makeDefault, renameDefault }) {
  const id = textInput(m.id, 'fast');
  let lastId = m.id || '';
  id.addEventListener('input', () => { renameDefault(lastId, id.value.trim()); lastId = id.value.trim(); });
  const label = textInput(m.label, 'Quick');
  const description = textInput(m.description, 'Everyday questions');
  const model = textInput(m.model, 'vendor/model-id');
  const connector = el('select');
  connectorChoices(connector, m.connector);
  const enabled = Object.assign(el('input'), { type: 'checkbox', checked: m.enabled !== false });
  const enabledLabel = el('label', 'inline-check');
  enabledLabel.append(enabled, ' Enabled: people can pick it');
  const tags = el('div', 'cfg-tags');
  const tagBoxes = TAGS.map((t) => {
    const cb = Object.assign(el('input'), { type: 'checkbox', checked: (m.tags || []).includes(t) });
    const l = el('label');
    l.append(cb, ` ${t}`);
    tags.appendChild(l);
    return [t, cb];
  });
  const defaultBtn = Object.assign(el('button'), { type: 'button' });
  const showDefault = () => {
    const on = isDefault(id.value.trim());
    defaultBtn.textContent = on ? 'Default model' : 'Make default';
    defaultBtn.disabled = on || locked;
  };
  defaultBtn.onclick = () => { makeDefault(id.value.trim()); showDefault(); };

  const inputs = OVERRIDES.map((spec) => [spec, overrideInput(spec, m[spec.key])]);
  const page = el('div');
  page.appendChild(group('Model', 'Who people see and where it is served from.', grid(
    field('Id', id, 'Stable handle: roles and preferences name this.'),
    field('Label', label, 'What people see.'),
    span2(field('Description', description)),
    field('Provider model id', model, 'Blank: the id above.'),
    field('Connector', connector),
    span2(field('Capabilities', tags)),
    span2(el('div', 'cfg-actions'))
  )));
  page.querySelector('.cfg-actions').append(enabledLabel, defaultBtn);
  for (const section of SECTIONS) {
    const mine = inputs.filter(([s]) => s.section === section);
    page.appendChild(group(section, section === 'Prompt' ? 'Blank fields inherit the defaults for all models.' : null,
      grid(...mine.map(([s, input]) => {
        const f = field(s.label, input, s.note);
        return s.type === 'textarea' || s.type === 'json' ? span2(f) : f;
      }))));
  }
  const remove = Object.assign(el('button'), { type: 'button', textContent: 'Remove model', className: 'danger' });
  remove.onclick = () => onRemove(page);
  const foot = el('div', 'set-foot');
  foot.appendChild(remove);
  page.appendChild(foot);

  page.refresh = () => {
    connectorChoices(connector, connector.value);
    for (const [spec, input] of inputs) inheritHint(spec, input);
    showDefault();
  };
  page.read = () => {
    const name = id.value.trim();
    const out = {
      id: name,
      ...(label.value.trim() ? { label: label.value.trim() } : {}),
      ...(description.value.trim() ? { description: description.value.trim() } : {}),
      ...(model.value.trim() ? { model: model.value.trim() } : {}),
      ...(connector.value ? { connector: connector.value } : {})
    };
    const chosen = tagBoxes.filter(([, cb]) => cb.checked).map(([t]) => t);
    if (chosen.length) out.tags = chosen;
    if (!enabled.checked) out.enabled = false;
    for (const [spec, input] of inputs) {
      const v = readOverride(spec, input, name);
      if (v !== undefined) out[spec.key] = v;
    }
    return out;
  };
  page.summary = () => ({
    id: id.value.trim(), label: label.value.trim(), model: model.value.trim(), connector: connector.value,
    enabled: enabled.checked, tags: tagBoxes.filter(([, cb]) => cb.checked).map(([t]) => t)
  });
  page.setConnector = (cid) => { connectorChoices(connector, cid); };
  return page;
}

/* ---------- the draft ---------- */

let hooks = {};

/**
 * `deps`: { isDefault(id), makeDefault(id), renameDefault(from, to), removed() }
 * -- the default model lives on the settings page, not in an entry.
 */
export function initModelEditor(deps) { hooks = deps; }

const removeFrom = (list, page) => { const i = list.indexOf(page); if (i >= 0) list.splice(i, 1); hooks.removed?.(); };

function addConnectorEditor(c) {
  const page = connectorEditor(c, {
    onRemove: (p) => removeFrom(connectorEditors, p),
    // A connector still being named carries the models already added under it.
    onRename: (from, to) => { if (from) for (const m of modelEditors) if (m.summary().connector === from) m.setConnector(to); }
  });
  connectorEditors.push(page);
  return page;
}

function addModelEditor(m) {
  const page = modelEditor(m, {
    onRemove: (p) => removeFrom(modelEditors, p),
    isDefault: (id) => hooks.isDefault(id),
    makeDefault: (id) => hooks.makeDefault(id),
    renameDefault: (from, to) => hooks.renameDefault(from, to)
  });
  modelEditors.push(page);
  return page;
}

/** Rebuilds the draft from /api/config. */
export function renderCatalog(cfg) {
  connectorEditors.length = 0;
  modelEditors.length = 0;
  for (const c of cfg.connectors || []) addConnectorEditor(c);
  for (const m of cfg.models || []) addModelEditor(m);
  setLocked(locked);
}

export const newConnector = () => { const p = addConnectorEditor({}); setLocked(locked); return p; };
export const newModel = (connector) => { const p = addModelEditor(connector ? { connector } : {}); setLocked(locked); return p; };
export const connectorPages = () => [...connectorEditors];
export const modelPages = () => [...modelEditors];

/** What the draft holds, as the config patch to save. Throws on bad JSON. */
export function collectCatalog() {
  return {
    connectors: connectorEditors.map((p) => p.read()),
    models: modelEditors.map((p) => p.read())
  };
}

/** Locks or unlocks every control in the catalog editors. */
export function setLocked(on) {
  locked = on;
  for (const p of [...connectorEditors, ...modelEditors]) for (const n of p.querySelectorAll('input,select,textarea,button')) n.disabled = on;
}
export const isCatalogLocked = () => locked;
