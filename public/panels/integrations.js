/**
 * The Integrations panel: every connected MCP server, and for those that
 * offer one, their management views (src/routes/integrations.ts).
 *
 * Everything shown here is drawn by this file from plain data -- labels,
 * numbers, text -- always as textContent. A server never supplies markup or
 * script, only values, so a hostile server can at worst show odd text.
 * What a person may open was decided by the server side; a view they cannot
 * use arrives with `available: false` and the reason, which is shown as is.
 */
import { $, el } from '../core/dom.js';
import { api } from '../core/api.js';

const body = $('integrationsBody');
const back = $('integrationsBack');
const title = $('integrationsTitle');

const ICON = { memory: '◎', search: '⌕', database: '▤', globe: '◍', tool: '⚒', plug: '⏚' };
const enc = encodeURIComponent;

let state = { servers: [], multiUser: false };
let current = null; // { server, view, query: {}, offset: 0 } while a server is open
let loadSeq = 0;

const text = (tag, cls, value) => Object.assign(el(tag, cls), { textContent: value ?? '' });

function format(value, fmt) {
  if (value === null || value === undefined || value === '') return '—';
  if (fmt === 'datetime') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
  }
  if (fmt === 'number' && typeof value === 'number') return value.toLocaleString();
  return String(value);
}

function chip(label, cls = '') { return text('span', `chip ${cls}`.trim(), label); }

function notice(message) { return message ? text('p', 'int-notice', message) : null; }

function errorBox(err) { return text('p', 'int-error', err.message || String(err)); }

/* ---------- the list ---------- */

function serverCard(s) {
  const card = el('section', 'statistics-block int-card');
  const head = el('div', 'int-head');
  const manifest = s.manifest;
  head.append(text('span', 'int-icon', ICON[manifest?.icon] || ICON.plug));
  const name = el('div', 'int-name');
  name.append(text('h3', '', manifest?.title || s.name));
  const meta = [s.name !== manifest?.title ? s.name : null, manifest?.version ? `v${manifest.version}` : null, `${s.tools} tool${s.tools === 1 ? '' : 's'}`]
    .filter(Boolean).join(' · ');
  name.append(text('span', 'usage', meta));
  head.append(name);
  const chips = el('span', 'int-chips');
  chips.append(chip(s.status === 'ok' ? 'connected' : s.status, s.status === 'ok' ? 'chip-ok' : 'chip-bad'));
  if (state.multiUser) chips.append(chip(s.perUser ? 'per person' : 'shared by everyone'));
  head.append(chips);
  card.append(head);
  if (manifest?.description) card.append(text('p', 'int-desc', manifest.description));
  if (s.error) card.append(text('p', 'int-error', s.error));
  if (s.manageError) card.append(text('p', 'int-error', `Management page unavailable: ${s.manageError}`));
  if (manifest && manifest.views.length) {
    const open = Object.assign(el('button', 'primary'), { type: 'button', textContent: 'Manage' });
    open.onclick = () => openServer(s.name);
    card.append(open);
  } else if (s.status === 'ok' && !s.manageError) {
    card.append(text('p', 'usage', 'Its tools work in chats; it offers no management page.'));
  }
  return card;
}

function renderList() {
  current = null;
  back.hidden = true;
  title.textContent = 'Integrations';
  if (!state.servers.length) {
    body.replaceChildren(text('p', 'empty', 'No MCP servers are connected.'));
    return;
  }
  body.replaceChildren(...state.servers.map(serverCard));
}

export async function loadIntegrations() {
  const seq = ++loadSeq;
  body.replaceChildren(text('p', 'empty', 'Loading…'));
  try {
    const data = await api.get('/api/integrations');
    if (seq !== loadSeq) return;
    state = data;
    if (current && state.servers.some((s) => s.name === current.server)) openServer(current.server, current.view);
    else renderList();
  } catch (err) {
    if (seq === loadSeq) body.replaceChildren(errorBox(err));
  }
}

/* ---------- one server ---------- */

function openServer(name, viewId) {
  const s = state.servers.find((x) => x.name === name);
  if (!s?.manifest) return renderList();
  const views = s.manifest.views;
  const first = views.find((v) => v.id === viewId) || views.find((v) => v.available) || views[0];
  current = { server: name, view: first.id, query: {}, offset: 0 };
  back.hidden = false;
  title.textContent = s.manifest.title || name;
  renderServer();
}

function renderServer() {
  const s = state.servers.find((x) => x.name === current.server);
  const tabs = el('div', 'int-tabs');
  tabs.setAttribute('role', 'tablist');
  for (const v of s.manifest.views) {
    const tab = Object.assign(el('button', v.id === current.view ? 'active' : ''), { type: 'button', textContent: v.title });
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(v.id === current.view));
    if (!v.available) tab.classList.add('off');
    tab.onclick = () => { current = { ...current, view: v.id, query: {}, offset: 0 }; renderServer(); };
    tabs.append(tab);
  }
  const slot = el('div', 'int-view');
  body.replaceChildren(tabs, slot);
  const view = s.manifest.views.find((v) => v.id === current.view);
  if (!view.available) {
    slot.replaceChildren(text('p', 'int-notice', view.reason || 'Not available to you.'));
    return;
  }
  loadView(s, view, slot);
}

const viewUrl = (server, view) => `/api/integrations/${enc(server)}/views/${enc(view.id)}`;

async function loadView(s, view, slot) {
  const seq = ++loadSeq;
  slot.replaceChildren(text('p', 'empty', 'Loading…'));
  const params = new URLSearchParams(Object.entries(current.query).filter(([, v]) => v));
  if (view.kind === 'table') params.set('offset', String(current.offset));
  try {
    const data = await api.get(`${viewUrl(s.name, view)}?${params}`);
    if (seq !== loadSeq) return;
    slot.replaceChildren(...(view.kind === 'stats' ? renderStats(data) : renderTable(s, view, data, slot)));
  } catch (err) {
    if (seq === loadSeq) slot.replaceChildren(errorBox(err));
  }
}

function renderStats(data) {
  const grid = el('div', 'int-stats');
  for (const item of data.items) {
    const cell = el('div', 'int-stat');
    cell.append(text('span', 'int-stat-label', item.label));
    const value = format(item.value, item.format);
    cell.append(text('span', 'int-stat-value', item.unit && value !== '—' ? `${value} ${item.unit}` : value));
    if (item.hint) cell.append(text('span', 'usage', item.hint));
    grid.append(cell);
  }
  return [notice(data.notice), grid].filter(Boolean);
}

function filters(s, view, slot) {
  if (!view.params.length && !view.actions.some((a) => a.target === 'view')) return null;
  const bar = el('div', 'int-filters');
  let timer;
  for (const p of view.params) {
    const id = `int-${p.name}`;
    const label = Object.assign(text('label', '', p.label), { htmlFor: id });
    let input;
    if (p.type === 'enum') {
      input = el('select');
      input.append(Object.assign(el('option'), { value: '', textContent: 'Any' }));
      for (const v of p.values) input.append(Object.assign(el('option'), { value: v, textContent: v }));
      input.onchange = () => { current.query[p.name] = input.value; current.offset = 0; loadView(s, view, slot); };
    } else {
      input = Object.assign(el('input'), { type: 'search', maxLength: p.maxLength });
      // Each keystroke would otherwise be a round trip to the server.
      input.oninput = () => {
        clearTimeout(timer);
        timer = setTimeout(() => { current.query[p.name] = input.value.trim(); current.offset = 0; loadView(s, view, slot); }, 300);
      };
    }
    input.id = id;
    input.value = current.query[p.name] || '';
    const field = el('div', 'int-field');
    field.append(label, input);
    bar.append(field);
  }
  for (const action of view.actions.filter((a) => a.target === 'view')) {
    bar.append(actionButton(s, view, action, null, () => loadView(s, view, slot)));
  }
  return bar;
}

function renderTable(s, view, data, slot) {
  const out = [];
  const bar = filters(s, view, slot);
  if (bar) out.push(bar);
  if (data.notice) out.push(notice(data.notice));
  if (!data.rows.length) {
    out.push(text('p', 'empty', current.offset ? 'No more rows.' : 'Nothing here yet.'));
  } else {
    const table = el('table', 'int-table');
    const thead = el('thead');
    const headRow = el('tr');
    for (const c of view.columns) headRow.append(text('th', c.format === 'number' ? 'num' : '', c.label));
    thead.append(headRow);
    table.append(thead);
    const tbody = el('tbody');
    for (const row of data.rows) {
      const tr = el('tr');
      for (const c of view.columns) tr.append(text('td', c.format === 'number' ? 'num' : '', format(row[c.key], c.format)));
      const rowActions = view.actions.filter((a) => a.target === 'row');
      if (view.hasDetail || rowActions.length) {
        tr.tabIndex = 0;
        tr.classList.add('int-row');
        const open = () => openRow(s, view, row, slot);
        tr.onclick = open;
        tr.onkeydown = (e) => { if (e.key === 'Enter') open(); };
      }
      tbody.append(tr);
    }
    table.append(tbody);
    out.push(table);
  }
  const pager = el('div', 'int-pager');
  const first = current.offset + 1;
  const last = current.offset + data.rows.length;
  pager.append(text('span', 'usage', data.rows.length
    ? `${first.toLocaleString()}–${last.toLocaleString()}${data.total !== null ? ` of ${data.total.toLocaleString()}` : ''}` : ''));
  const prev = Object.assign(el('button'), { type: 'button', textContent: '‹ Previous', disabled: current.offset === 0 });
  prev.onclick = () => { current.offset = Math.max(0, current.offset - view.pageSize); loadView(s, view, slot); };
  const next = Object.assign(el('button'), { type: 'button', textContent: 'Next ›', disabled: !data.hasMore });
  next.onclick = () => { current.offset += data.rows.length || view.pageSize; loadView(s, view, slot); };
  pager.append(prev, next);
  out.push(pager);
  return out;
}

/* ---------- one row ---------- */

async function openRow(s, view, row, slot) {
  const seq = ++loadSeq;
  const backToList = Object.assign(el('button', 'int-back-row'), { type: 'button', textContent: '‹ Back to the list' });
  backToList.onclick = () => loadView(s, view, slot);
  const panel = el('div', 'int-detail');
  slot.replaceChildren(backToList, panel);
  let detail = { fields: view.columns.map((c) => ({ label: c.label, value: row[c.key], format: c.format })), row };
  if (view.hasDetail && view.rowKey && row[view.rowKey] !== null) {
    panel.replaceChildren(text('p', 'empty', 'Loading…'));
    try {
      detail = await api.get(`${viewUrl(s.name, view)}/items/${enc(String(row[view.rowKey]))}`);
      if (seq !== loadSeq) return;
    } catch (err) {
      if (seq === loadSeq) panel.replaceChildren(errorBox(err));
      return;
    }
  }
  const target = detail.row || row;
  const dl = el('dl', 'int-fields');
  for (const f of detail.fields) {
    dl.append(text('dt', '', f.label), text('dd', f.format === 'multiline' ? 'multiline' : '', format(f.value, f.format)));
  }
  const actions = el('div', 'int-actions');
  for (const action of view.actions.filter((a) => a.target === 'row')) {
    actions.append(actionButton(s, view, action, target, () => loadView(s, view, slot), panel));
  }
  panel.replaceChildren(dl, actions);
}

/* ---------- actions ---------- */

function actionButton(s, view, action, row, done, host = null) {
  const button = Object.assign(el('button', action.destructive ? 'danger' : ''), { type: 'button', textContent: action.label });
  button.onclick = () => (action.input ? editForm(s, view, action, row, done, host || button.parentElement) : run(s, view, action, row, null, done, button));
  return button;
}

function editForm(s, view, action, row, done, host) {
  const form = el('form', 'int-edit');
  const id = `int-input-${action.id}`;
  const label = Object.assign(text('label', '', action.input.label), { htmlFor: id });
  const field = action.input.multiline ? el('textarea') : Object.assign(el('input'), { type: 'text' });
  Object.assign(field, { id, maxLength: action.input.maxLength, required: true });
  if (action.input.multiline) field.rows = 6;
  field.value = action.input.initial && row ? String(row[action.input.initial] ?? '') : '';
  const save = Object.assign(el('button', 'primary'), { type: 'submit', textContent: 'Save' });
  const cancel = Object.assign(el('button'), { type: 'button', textContent: 'Cancel' });
  cancel.onclick = () => form.remove();
  const row_ = el('div', 'int-actions');
  row_.append(save, cancel);
  form.append(label, field, row_);
  form.onsubmit = (e) => { e.preventDefault(); run(s, view, action, row, field.value, done, save); };
  host.querySelector('.int-edit')?.remove();
  host.append(form);
  field.focus();
}

async function run(s, view, action, row, input, done, button) {
  // The server refuses a destructive action without this; the browser's
  // part is to make sure a person actually said yes.
  if (action.destructive && !window.confirm(action.confirm || `${action.label}? This cannot be undone.`)) return;
  button.disabled = true;
  try {
    const res = await api.post(`${viewUrl(s.name, view)}/actions/${enc(action.id)}`, {
      row: row || undefined, input: input ?? undefined, confirm: action.destructive ? true : undefined
    });
    if (!res.ok) throw new Error(res.message || 'The server refused.');
    done();
  } catch (err) {
    button.disabled = false;
    button.insertAdjacentElement('afterend', errorBox(err));
  }
}

export function initIntegrations() {
  back.onclick = () => { current = null; loadIntegrations(); };
}
