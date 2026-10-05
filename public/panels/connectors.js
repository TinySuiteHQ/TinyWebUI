/**
 * The admin editors for connectors (endpoint + key) and the model catalog.
 * Keys are write-only: a row shows whether one is set (and its last four
 * characters), and a blank key field means "keep it". Everything is read back
 * from the DOM on save, so the rows are the draft until then.
 */
import { $, el } from '../core/dom.js';
import { api } from '../core/api.js';

const TAGS = ['vision', 'reasoning', 'tools'];
// Per-model settings with no field of their own; edited as one JSON object.
const OVERRIDE_KEYS = ['systemPrompt', 'temperature', 'maxTokens', 'maxToolRounds', 'cacheMode', 'cacheTtl', 'extraBody', 'reasoningReplay'];

function field(label, input, note) {
  const wrap = el('div');
  const l = el('label');
  l.textContent = label;
  wrap.append(l, input);
  if (note) wrap.appendChild(Object.assign(el('small'), { textContent: note }));
  return wrap;
}

const textInput = (value, placeholder) => Object.assign(el('input'), { value: value ?? '', placeholder: placeholder || '', spellcheck: false });

function removeButton(row) {
  const b = Object.assign(el('button'), { type: 'button', textContent: 'Remove' });
  b.onclick = () => row.remove();
  return b;
}

/* ---------- connectors ---------- */

function connectorRow(c = {}) {
  const row = el('div', 'cfg-row');
  row.dataset.kind = 'connector';
  const id = textInput(c.id, 'local');
  // An id is what models name; renaming a saved one would orphan them.
  if (c.id) id.readOnly = true;
  const label = textInput(c.label, 'Local models');
  const url = textInput(c.baseUrl, 'http://localhost:11434/v1');
  const key = Object.assign(textInput('', c.hasApiKey ? `set (…${c.keyHint || ''})` : 'none'), { type: 'password', autocomplete: 'off' });
  const clear = Object.assign(el('input'), { type: 'checkbox' });
  const grid = el('div', 'set-grid');
  grid.append(
    field('Id', id, 'What a model names in its connector field.'),
    field('Label', label),
    Object.assign(field('API URL', url), { className: 'span-2' }),
    Object.assign(field('API key', key, 'Write-only. Blank keeps the current key.'), { className: 'span-2' })
  );
  const test = Object.assign(el('button'), { type: 'button', textContent: 'Test connection' });
  const msg = el('span', 'usage');
  test.onclick = async () => {
    msg.textContent = 'testing…';
    try {
      const out = await api.post('/api/connectors/test', { id: id.value.trim(), baseUrl: url.value.trim(), apiKey: key.value });
      msg.textContent = out.ok ? `reachable${out.models != null ? ` · ${out.models} models` : ''}` : out.error || `status ${out.status}`;
    } catch (err) { msg.textContent = err.message; }
  };
  const clearLabel = el('label');
  clearLabel.append(clear, ' remove stored key');
  const actions = el('div', 'cfg-actions');
  actions.append(test, msg, ...(c.hasApiKey ? [clearLabel] : []), removeButton(row));
  row.append(grid, actions);
  row.read = () => ({
    id: id.value.trim(),
    ...(label.value.trim() ? { label: label.value.trim() } : {}),
    baseUrl: url.value.trim(),
    // undefined keeps the stored key on the server; null clears it.
    ...(key.value ? { apiKey: key.value } : clear.checked ? { apiKey: null } : {})
  });
  return row;
}

/* ---------- model catalog ---------- */

function modelRow(m = {}, connectorIds = []) {
  const row = el('div', 'cfg-row');
  row.dataset.kind = 'model';
  const id = textInput(m.id, 'fast');
  const label = textInput(m.label, 'Quick');
  const description = textInput(m.description, 'Everyday questions');
  const model = textInput(m.model, 'vendor/model-id');
  const connector = el('select');
  connector.className = 'model-connector';
  const none = Object.assign(el('option'), { value: '', textContent: 'Default endpoint' });
  connector.appendChild(none);
  for (const cid of connectorIds) connector.appendChild(Object.assign(el('option'), { value: cid, textContent: cid }));
  if (m.connector && !connectorIds.includes(m.connector)) connector.appendChild(Object.assign(el('option'), { value: m.connector, textContent: m.connector }));
  connector.value = m.connector || '';
  const enabled = Object.assign(el('input'), { type: 'checkbox', checked: m.enabled !== false });
  const tags = el('div', 'cfg-tags');
  const tagBoxes = TAGS.map((t) => {
    const cb = Object.assign(el('input'), { type: 'checkbox', checked: (m.tags || []).includes(t) });
    const l = el('label');
    l.append(cb, ` ${t}`);
    tags.appendChild(l);
    return [t, cb];
  });
  const overrides = Object.assign(el('textarea'), { rows: 3, spellcheck: false, placeholder: '{ "temperature": 0.3 }' });
  const kept = Object.fromEntries(OVERRIDE_KEYS.filter((k) => m[k] !== undefined).map((k) => [k, m[k]]));
  overrides.value = Object.keys(kept).length ? JSON.stringify(kept, null, 2) : '';
  const enabledLabel = el('label');
  enabledLabel.append(enabled, ' enabled');

  const grid = el('div', 'set-grid');
  grid.append(
    field('Id', id, 'Stable handle: roles and preferences name this.'),
    field('Label', label, 'What people see.'),
    Object.assign(field('Description', description), { className: 'span-2' }),
    field('Provider model id', model, 'Blank: the id above.'),
    field('Connector', connector),
    Object.assign(field('Capabilities', tags), { className: 'span-2' }),
    Object.assign(field('Overrides (JSON)', overrides, `Optional: ${OVERRIDE_KEYS.join(', ')}.`), { className: 'span-2' })
  );
  const actions = el('div', 'cfg-actions');
  actions.append(enabledLabel, removeButton(row));
  row.append(grid, actions);
  row.read = () => {
    let extra = {};
    if (overrides.value.trim()) {
      try { extra = JSON.parse(overrides.value); } catch (err) { throw new Error(`model "${id.value.trim()}" overrides: ${err.message}`); }
      const bad = Object.keys(extra).filter((k) => !OVERRIDE_KEYS.includes(k));
      if (bad.length || !extra || typeof extra !== 'object' || Array.isArray(extra)) throw new Error(`model "${id.value.trim()}" overrides must be an object of: ${OVERRIDE_KEYS.join(', ')}`);
    }
    const chosen = tagBoxes.filter(([, cb]) => cb.checked).map(([t]) => t);
    return {
      id: id.value.trim(),
      ...(label.value.trim() ? { label: label.value.trim() } : {}),
      ...(description.value.trim() ? { description: description.value.trim() } : {}),
      ...(model.value.trim() ? { model: model.value.trim() } : {}),
      ...(connector.value ? { connector: connector.value } : {}),
      ...(chosen.length ? { tags: chosen } : {}),
      ...(enabled.checked ? {} : { enabled: false }),
      ...extra
    };
  };
  return row;
}

const rows = (box) => [...box.children];
const connectorIds = () => rows($('connectorsBox')).map((r) => r.read().id).filter(Boolean);

/** Rebuilds both editors from /api/config. */
export function renderConnectors(cfg) {
  $('connectorsBox').replaceChildren(...(cfg.connectors || []).map((c) => connectorRow(c)));
  const ids = (cfg.connectors || []).map((c) => c.id);
  $('modelsBox').replaceChildren(...(cfg.models || []).map((m) => modelRow(m, ids)));
}

/** What the editors currently hold, as the config patch to save. Throws on bad JSON. */
export function collectConnectors() {
  return {
    connectors: rows($('connectorsBox')).map((r) => r.read()),
    models: rows($('modelsBox')).map((r) => r.read())
  };
}

/** Locks or unlocks every control in the three admin editors. */
export function lockConnectors(locked) {
  for (const id of ['connectorsBox', 'modelsBox']) for (const n of $(id).querySelectorAll('input,select,textarea,button')) n.disabled = locked;
  $('addConnector').disabled = locked;
  $('addModel').disabled = locked;
}

export function initConnectors() {
  $('addConnector').onclick = () => {
    $('connectorsBox').appendChild(connectorRow());
    // New connector ids become choices in every model row.
    refreshConnectorChoices();
  };
  $('addModel').onclick = () => $('modelsBox').appendChild(modelRow({}, connectorIds()));
  // Ids are typed after the row exists, so the model rows re-read them on focus.
  $('modelsBox').addEventListener('focusin', (e) => { if (e.target.classList?.contains('model-connector')) refreshConnectorChoices(); });
}

function refreshConnectorChoices() {
  const ids = connectorIds();
  for (const sel of $('modelsBox').querySelectorAll('.model-connector')) {
    const current = sel.value;
    sel.replaceChildren(Object.assign(el('option'), { value: '', textContent: 'Default endpoint' }),
      ...[...new Set([...ids, ...(current && !ids.includes(current) ? [current] : [])])].map((cid) => Object.assign(el('option'), { value: cid, textContent: cid })));
    sel.value = current;
  }
}
