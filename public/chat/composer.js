/**
 * The composer's two menus: + (attach files, turn tools and MCP servers on
 * and off) and the model chip (switch model). Both are popovers anchored to
 * the composer card and rebuilt from the server every time they open, so they
 * never show a state the server has already moved past.
 */
import { $, el } from '../core/dom.js';
import { can, whoami, loadAccess } from '../core/access.js';
import { addError } from './transcript.js';
import { pickFiles } from './attachments.js';
import { openLibrary } from './library.js';
import { FEATURE } from '../shared/features.js';
import { api } from '../core/api.js';

const form = $('form');
const attachBtn = $('attach');
const modelBtn = $('modelBtn');

let open = null; // { pop, btn }

// Handed in by initComposer: the deployment config lives in the settings
// panel, and the MCP panel is what "Manage MCP servers" opens.
let config;
let openMcp;

function closeMenu() {
  if (!open) return;
  open.pop.remove();
  open.btn.setAttribute('aria-expanded', 'false');
  open = null;
}

function openMenu(btn, side, build) {
  const same = open?.btn === btn;
  closeMenu();
  if (same) return;
  const pop = el('div', `popover popover-${side}`);
  pop.setAttribute('role', 'menu');
  form.appendChild(pop);
  btn.setAttribute('aria-expanded', 'true');
  open = { pop, btn };
  build(pop);
  fitToViewport(pop);
}

/**
 * Opens the popover on whichever side of the composer has more room and caps
 * its height to that room, so it never hangs off the viewport (short phone
 * screens, the centred empty-chat composer, an open mobile keyboard).
 */
function fitToViewport(pop) {
  const gap = 8;
  const rect = form.getBoundingClientRect();
  const vh = window.visualViewport?.height ?? window.innerHeight;
  const above = rect.top - gap * 2;
  const below = vh - rect.bottom - gap * 2;
  const up = above >= below;
  pop.style.top = up ? 'auto' : 'calc(100% + .5rem)';
  pop.style.bottom = up ? 'calc(100% + .5rem)' : 'auto';
  pop.style.transformOrigin = `${up ? 'bottom' : 'top'} ${pop.classList.contains('popover-right') ? 'right' : 'left'}`;
  pop.style.maxHeight = `${Math.max(120, Math.min(448, up ? above : below))}px`;
}

/**
 * `deps.config`: { load, loadTools, loadMcp, isLocked, isReadOnly, model } from
 * the settings panel. `deps.openMcp()`: shows the MCP servers panel.
 */
export function initComposer(deps) {
  ({ config, openMcp } = deps);
  window.visualViewport?.addEventListener('resize', () => { if (open) fitToViewport(open.pop); });
  document.addEventListener('pointerdown', (e) => {
    if (open && !open.pop.contains(e.target) && !open.btn.contains(e.target)) closeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && open) { const b = open.btn; closeMenu(); b.focus(); }
  });
  attachBtn.addEventListener('click', () => openMenu(attachBtn, 'left', buildToolsMenu));
  modelBtn.addEventListener('click', () => openMenu(modelBtn, 'right', buildModelMenu));
}

/** An on/off switch; `onToggle(next)` returns a promise, and the switch holds still until it settles. */
function toggle(on, label, onToggle) {
  const sw = el('button', 'switch');
  sw.type = 'button';
  sw.setAttribute('role', 'switch');
  sw.setAttribute('aria-checked', String(on));
  sw.setAttribute('aria-label', label);
  // Tool and server switches are deployment config: admins only.
  if (config.isReadOnly()) { sw.disabled = true; sw.title = 'Managed by your administrator'; }
  sw.onclick = async (e) => {
    e.stopPropagation();
    sw.disabled = true;
    try { await onToggle(!on); } catch (err) { addError(err.message); sw.disabled = false; }
  };
  return sw;
}

/* ---- + menu: attach and tools ---- */

async function buildToolsMenu(pop) {
  if (can(FEATURE.ATTACHMENTS) || can(FEATURE.IMAGES)) {
  const attach = el('button', 'pop-item');
  attach.type = 'button';
  attach.setAttribute('role', 'menuitem');
  attach.innerHTML = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5 12.5 20a5.5 5.5 0 0 1-7.8-7.8l8.9-8.9a3.7 3.7 0 0 1 5.2 5.2l-8.9 8.9a1.8 1.8 0 0 1-2.6-2.6L15.5 7"/></svg><span>Attach files</span>';
  attach.onclick = () => { closeMenu(); pickFiles(); };
  pop.appendChild(attach);
  // Documents only: an image has no stored text to reuse.
  if (can(FEATURE.ATTACHMENTS)) {
    const earlier = el('button', 'pop-item');
    earlier.type = 'button';
    earlier.setAttribute('role', 'menuitem');
    earlier.innerHTML = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/></svg><span>Attach from earlier chats</span>';
    earlier.onclick = () => { closeMenu(); openLibrary(); };
    pop.appendChild(earlier);
  }
  if (!can(FEATURE.TOOLS)) return;
  pop.appendChild(el('hr', 'pop-sep'));
  }

  const body = el('div', 'pop-scroll');
  body.appendChild(Object.assign(el('div', 'pop-note'), { textContent: 'Loading tools…' }));
  pop.appendChild(body);

  const manage = el('button', 'pop-item pop-foot');
  manage.type = 'button';
  manage.textContent = 'Manage MCP servers';
  manage.onclick = () => { closeMenu(); openMcp(); };
  if (can(FEATURE.MCP)) pop.appendChild(manage);

  let data;
  try { data = await api.get('/api/tools'); } catch (err) {
    body.firstChild.textContent = `Could not load tools: ${err.message}`;
    return;
  }
  renderTools(body, data);
}

/** Groups: built-ins, then one per MCP server. A group's tools expand under it. */
function renderTools(body, data) {
  body.innerHTML = '';
  const refresh = (out) => { renderTools(body, out); config.loadTools(); config.load(); };
  const toggleTool = async (name, on) => refresh(await api.post('/api/tools/toggle', { name, disabled: !on }));

  const group = ({ title, tools, status, error, serverName, serverOn }) => {
    const box = el('details', 'pop-group');
    const head = el('summary', 'pop-item');
    const enabled = tools.filter((t) => !t.disabled).length;
    const dot = el('span', `pop-dot ${status || 'ok'}`);
    const name = Object.assign(el('span', 'pop-name'), { textContent: title });
    const meta = Object.assign(el('span', 'pop-meta'), {
      textContent: status === 'disabled' ? 'off' : status === 'error' ? 'not connected' : `${enabled}/${tools.length}`
    });
    if (error) head.title = error;
    head.append(dot, name, meta);
    if (serverName) {
      head.appendChild(toggle(serverOn, `${title} server`, async (next) => {
        const out = await api.post(`/api/mcp/servers/${encodeURIComponent(serverName)}/toggle`, { disabled: !next });
        refresh(out);
        config.loadMcp();
      }));
    }
    box.appendChild(head);
    const list = el('div', 'pop-tools');
    for (const t of tools) {
      const row = el('div', 'pop-tool');
      const n = Object.assign(el('span', 'pop-tool-name'), { textContent: t.name, title: t.description || '' });
      row.append(n, toggle(!t.disabled, t.name, (next) => toggleTool(t.name, next)));
      list.appendChild(row);
    }
    if (!tools.length) list.appendChild(Object.assign(el('div', 'pop-note'), { textContent: 'No tools' }));
    box.appendChild(list);
    return box;
  };

  const total = [...data.internal, ...data.servers.flatMap((s) => s.tools)];
  const on = total.filter((t) => !t.disabled).length;
  body.appendChild(Object.assign(el('div', 'pop-label'), { textContent: `Tools · ${on} of ${total.length} on` }));
  if (data.internal.length) body.appendChild(group({ title: 'Built-in', tools: data.internal }));
  for (const s of data.servers) {
    body.appendChild(group({
      title: s.name, tools: s.tools, status: s.status, error: s.error,
      serverName: s.name, serverOn: s.status !== 'disabled'
    }));
  }
  if (!data.servers.length) {
    body.appendChild(Object.assign(el('div', 'pop-note'), { textContent: 'No MCP servers yet. Add them under MCP servers.' }));
  }
}

/* ---- model menu ---- */

async function buildModelMenu(pop) {
  // Tier 3: the pill is a personal choice among your role's models, saved
  // per user; it never changes anyone else's model.
  const personal = whoami().authMode === 'trusted-header';
  const current = personal ? whoami().model : config.model();
  if (!personal && config.isLocked('model')) {
    pop.appendChild(Object.assign(el('div', 'pop-note'), {
      textContent: config.isReadOnly() ? 'The model is managed by your administrator.' : 'The model is set in code and cannot be switched here.'
    }));
    return;
  }

  const search = el('input', 'pop-search');
  search.type = 'search';
  search.placeholder = 'Search models or type an id';
  search.setAttribute('aria-label', 'Search models');
  pop.appendChild(search);
  const list = el('div', 'pop-scroll');
  list.appendChild(Object.assign(el('div', 'pop-note'), { textContent: 'Loading models…' }));
  pop.appendChild(list);
  search.focus();

  const choose = async (id) => {
    closeMenu();
    if (!id || id === current) return;
    try {
      if (personal) { await api.post('/api/me/prefs', { model: id }); await loadAccess(); }
      else await api.post('/api/config', { model: id });
    } catch (err) { return addError(err.message); }
    await config.load();
  };

  let models = [];
  let supported = true;
  // A configured catalog is closed: labels only, no typing arbitrary ids.
  let closed = false;
  try {
    const out = await api.get('/api/models');
    models = out.models || [];
    supported = out.supported;
    closed = Boolean(out.catalog);
  } catch { supported = false; }
  if (closed) search.placeholder = 'Search models';

  const render = () => {
    const q = search.value.trim().toLowerCase();
    list.innerHTML = '';
    const hits = models.filter((m) => !q || (!closed && m.id.toLowerCase().includes(q))
      || (m.name || '').toLowerCase().includes(q) || (m.description || '').toLowerCase().includes(q));
    for (const m of hits.slice(0, 200)) {
      const b = el('button', 'pop-item pop-model');
      b.type = 'button';
      b.dataset.id = m.id;
      b.setAttribute('role', 'menuitemradio');
      b.setAttribute('aria-checked', String(m.id === current));
      b.appendChild(Object.assign(el('span', 'pop-name'), { textContent: closed ? m.name : m.id }));
      const meta = closed ? m.description : m.name;
      if (meta) b.appendChild(Object.assign(el('span', 'pop-meta'), { textContent: meta }));
      b.onclick = () => choose(m.id);
      list.appendChild(b);
    }
    // Typing an exact id always works, listed or not -- local runtimes and
    // private deployments often serve models /models never mentions.
    const typed = search.value.trim();
    if (typed && !closed && !models.some((m) => m.id === typed)) {
      const b = el('button', 'pop-item');
      b.type = 'button';
      b.textContent = `Use "${typed}"`;
      b.onclick = () => choose(typed);
      list.appendChild(b);
    }
    if (!list.children.length) {
      list.appendChild(Object.assign(el('div', 'pop-note'), {
        textContent: supported ? 'No models match.' : 'This provider does not list its models. Type a model id and press Enter.'
      }));
    }
  };
  search.oninput = render;
  search.onkeydown = (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    // Exact id first, then the top match, then whatever was typed.
    const q = search.value.trim();
    const first = list.querySelector('.pop-model')?.dataset.id;
    if (closed) return first && choose(first);
    choose(models.some((m) => m.id === q) ? q : first || q);
  };
  render();
}
