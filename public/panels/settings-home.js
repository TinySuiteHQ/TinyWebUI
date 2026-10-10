/**
 * The settings home page: one card per endpoint (the default one, then each
 * connector) with the models it serves listed under it. Rebuilt from the
 * draft every time it is shown, so it always reflects unsaved edits.
 */
import { $, el } from '../core/dom.js';
import { connectorPages, modelPages, newModel, isCatalogLocked } from './model-editor.js';

function modelLink(page, { open, defaultModel }) {
  const s = page.summary();
  const b = el('button', 'model-link');
  b.type = 'button';
  if (!s.enabled) b.classList.add('off');
  const name = el('span', 'model-name');
  name.textContent = s.label || s.id || 'Untitled model';
  const sub = el('span', 'model-sub');
  sub.textContent = [s.model || s.id, s.enabled ? '' : 'disabled'].filter(Boolean).join(' · ');
  const chips = el('span', 'model-chips');
  if (s.id && s.id === defaultModel) chips.appendChild(Object.assign(el('span', 'chip chip-default'), { textContent: 'default' }));
  for (const t of s.tags) chips.appendChild(Object.assign(el('span', 'chip'), { textContent: t }));
  const text = el('span', 'model-text');
  text.append(name, sub);
  b.append(text, chips, Object.assign(el('span', 'chev'), { textContent: '›', ariaHidden: 'true' }));
  b.onclick = () => open('model', page);
  return b;
}

function card({ title, detail, onEdit, connectorId, models, deps, extra }) {
  const c = el('section', 'set-group ep-card');
  const head = el('div', 'ep-head');
  const t = el('div');
  t.appendChild(Object.assign(el('h3'), { textContent: title }));
  t.appendChild(Object.assign(el('p'), { textContent: detail }));
  const edit = Object.assign(el('button'), { type: 'button', textContent: 'Edit' });
  edit.onclick = onEdit;
  head.append(t, ...(onEdit ? [edit] : []));
  c.appendChild(head);
  if (models.length) {
    const list = el('div', 'model-list');
    for (const p of models) list.appendChild(modelLink(p, deps));
    c.appendChild(list);
  }
  if (extra) c.appendChild(extra);
  if (connectorId !== null && !isCatalogLocked()) {
    const add = Object.assign(el('button', 'add-model'), { type: 'button', textContent: '+ Add model' });
    add.onclick = () => deps.open('model', newModel(connectorId));
    c.appendChild(add);
  }
  return c;
}

const host = (url) => { try { return new URL(url).host || url; } catch { return url; } };

/**
 * `deps`: { open(view, page?), defaultModel, defaultKey: { set, hint },
 * defaultModelField } -- the field is shown on the default card while the
 * catalog is empty, since any model id goes then.
 */
export function renderHome(deps) {
  const models = modelPages();
  const connectors = connectorPages();
  const ids = new Set(connectors.map((p) => p.summary().id));
  const under = (cid) => models.filter((p) => (p.summary().connector || '') === cid);
  const baseUrl = $('baseUrl').value.trim();
  const cards = [];

  let extra = null;
  if (!models.length) {
    extra = el('div', 'ep-open');
    extra.appendChild(deps.defaultModelField);
    extra.appendChild(Object.assign(el('small'), { textContent: 'No models are listed, so any model id goes. Add one to choose exactly which models people can pick.' }));
  }
  cards.push(card({
    title: 'Default endpoint',
    detail: `${baseUrl ? host(baseUrl) : 'no URL set'} · ${deps.defaultKey.set ? `key …${deps.defaultKey.hint || ''}` : 'no key'}`,
    onEdit: () => deps.open('endpoint'),
    connectorId: '',
    models: under(''),
    deps,
    extra
  }));
  for (const p of connectors) {
    const s = p.summary();
    cards.push(card({
      title: s.label || s.id || 'New connector',
      detail: `${s.id ? `${s.id} · ` : ''}${s.baseUrl ? host(s.baseUrl) : 'no URL set'} · ${s.hasKey ? 'key set' : 'no key'}`,
      onEdit: () => deps.open('connector', p),
      connectorId: s.id,
      models: under(s.id),
      deps
    }));
  }
  // Models naming a connector that no longer exists still need a way in.
  const orphans = models.filter((p) => { const c = p.summary().connector; return c && !ids.has(c); });
  if (orphans.length) {
    cards.push(card({ title: 'Unknown connector', detail: 'These models name a connector that is not defined.', connectorId: null, models: orphans, deps }));
  }
  $('endpointCards').replaceChildren(...cards);
}
