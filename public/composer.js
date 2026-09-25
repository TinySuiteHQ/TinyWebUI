/**
 * The composer's two menus: + (attach files, turn tools and MCP servers on
 * and off) and the model chip (switch model). Both are popovers anchored to
 * the composer card and rebuilt from the server every time they open, so they
 * never show a state the server has already moved past.
 */
import { $, el } from './dom.js';
import { loadConfig, loadMcp, loadTools, isLocked, isReadOnly } from './settings.js';
import { can, whoami } from './access.js';
import { addError } from './transcript.js';

const form = $('form');
const attachBtn = $('attach');
const modelBtn = $('modelBtn');

let open = null; // { pop, btn }

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
}

document.addEventListener('pointerdown', (e) => {
  if (open && !open.pop.contains(e.target) && !open.btn.contains(e.target)) closeMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && open) { const b = open.btn; closeMenu(); b.focus(); }
});

const post = async (url, body) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `${res.status}`);
  return out;
};

/** An on/off switch; `onToggle(next)` returns a promise, and the switch holds still until it settles. */
function toggle(on, label, onToggle) {
  const sw = el('button', 'switch');
  sw.type = 'button';
  sw.setAttribute('role', 'switch');
  sw.setAttribute('aria-checked', String(on));
  sw.setAttribute('aria-label', label);
  // Tool and server switches are deployment config: admins only.
  if (isReadOnly()) { sw.disabled = true; sw.title = 'Managed by your administrator'; }
  sw.onclick = async (e) => {
    e.stopPropagation();
    sw.disabled = true;
    try { await onToggle(!on); } catch (err) { addError(err.message); sw.disabled = false; }
  };
  return sw;
}

/* ---- + menu: attach and tools ---- */

async function buildToolsMenu(pop) {
  if (can('attachments') || can('images')) {
  const attach = el('button', 'pop-item');
  attach.type = 'button';
  attach.setAttribute('role', 'menuitem');
  attach.innerHTML = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5 12.5 20a5.5 5.5 0 0 1-7.8-7.8l8.9-8.9a3.7 3.7 0 0 1 5.2 5.2l-8.9 8.9a1.8 1.8 0 0 1-2.6-2.6L15.5 7"/></svg><span>Attach files</span>';
  attach.onclick = () => { closeMenu(); $('fileInput').click(); };
  pop.appendChild(attach);
  if (!can('tools')) return;
  pop.appendChild(el('hr', 'pop-sep'));
  }

  const body = el('div', 'pop-scroll');
  body.appendChild(Object.assign(el('div', 'pop-note'), { textContent: 'Loading tools…' }));
  pop.appendChild(body);

  const manage = el('button', 'pop-item pop-foot');
  manage.type = 'button';
  manage.textContent = 'Manage MCP servers';
  manage.onclick = () => { closeMenu(); if (!$('mcp').classList.contains('open')) $('toggle-mcp').click(); };
  if (can('mcp')) pop.appendChild(manage);

  let data;
  try { data = await (await fetch('/api/tools')).json(); } catch (err) {
    body.firstChild.textContent = `Could not load tools: ${err.message}`;
    return;
  }
  renderTools(body, data);
}

/** Groups: built-ins, then one per MCP server. A group's tools expand under it. */
function renderTools(body, data) {
  body.innerHTML = '';
  const refresh = (out) => { renderTools(body, out); loadTools(); loadConfig(); };
  const toggleTool = async (name, on) => refresh(await post('/api/tools/toggle', { name, disabled: !on }));

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
        const out = await post(`/api/mcp/servers/${encodeURIComponent(serverName)}/toggle`, { disabled: !next });
        refresh(out);
        loadMcp();
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
  const current = $('model').value;
  if (isLocked('model')) {
    pop.appendChild(Object.assign(el('div', 'pop-note'), {
      textContent: isReadOnly() ? 'The model is managed by your administrator.' : 'The model is set in code and cannot be switched here.'
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
    try { await post('/api/config', { model: id }); } catch (err) { return addError(err.message); }
    await loadConfig();
  };

  let models = [];
  let supported = true;
  try {
    const out = await (await fetch('/api/models')).json();
    models = out.models || [];
    supported = out.supported;
  } catch { supported = false; }

  const render = () => {
    const q = search.value.trim().toLowerCase();
    list.innerHTML = '';
    const hits = models.filter((m) => !q || m.id.toLowerCase().includes(q) || (m.name || '').toLowerCase().includes(q));
    for (const m of hits.slice(0, 200)) {
      const b = el('button', 'pop-item pop-model');
      b.type = 'button';
      b.setAttribute('role', 'menuitemradio');
      b.setAttribute('aria-checked', String(m.id === current));
      const id = Object.assign(el('span', 'pop-name'), { textContent: m.id });
      b.appendChild(id);
      if (m.name) b.appendChild(Object.assign(el('span', 'pop-meta'), { textContent: m.name }));
      b.onclick = () => choose(m.id);
      list.appendChild(b);
    }
    // Typing an exact id always works, listed or not -- local runtimes and
    // private deployments often serve models /models never mentions.
    const typed = search.value.trim();
    if (typed && !models.some((m) => m.id === typed)) {
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
    const first = list.querySelector('.pop-model .pop-name')?.textContent;
    choose(models.some((m) => m.id === q) ? q : first || q);
  };
  render();
}

attachBtn.addEventListener('click', () => openMenu(attachBtn, 'left', buildToolsMenu));
modelBtn.addEventListener('click', () => openMenu(modelBtn, 'right', buildModelMenu));
