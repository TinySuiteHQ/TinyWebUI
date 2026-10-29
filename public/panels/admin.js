/**
 * Admin panel: the users the gateway (or login) has provisioned, with just
 * enough control to approve, disable or promote them. Shown only to admins;
 * the server enforces the same rule on every /api/admin call regardless.
 */
import { $, el } from '../core/dom.js';
import { renderMarkdown } from '../core/md.js';
import { whoami } from '../core/access.js';
import { api } from '../core/api.js';
import { showView as showConnectorView } from './integrations.js';

let me = null;
let adminLoadRequest = 0;
// Bumped by every admin view change; a response for an older view is dropped.
let adminViewRequest = 0;

/** Wires Log out for whoever is signed in (nav visibility is core/access.js's). */
export function initAdmin() {
  me = whoami();
  if (me.logoutUrl || me.authMode === 'multiuser') {
    const btn = $('logout');
    btn.hidden = false;
    btn.onclick = async () => {
      try { await api.post('/api/auth/logout'); } catch { /* going anyway */ }
      // Behind a gateway, the gateway owns the session; ending it is its job.
      if (me.logoutUrl) location.href = me.logoutUrl; else location.reload();
    };
  }
  if (me.authMode === 'multiuser') {
    const form = $('adminInvite');
    form.hidden = false;
    form.onsubmit = async (event) => {
      event.preventDefault();
      const result = $('inviteResult');
      result.textContent = '';
      try {
        const out = await api.post('/api/admin/invites', { email: $('inviteEmail').value.trim() || null });
        const url = new URL(out.path, location.origin).href;
        const link = Object.assign(el('a'), { href: url, textContent: url });
        result.replaceChildren('Share this link once: ', link);
        $('inviteEmail').value = '';
        await loadInvites();
      } catch (err) { result.textContent = err.message; }
    };
  }
}

const fmt = (ts) => (ts ? new Date(ts).toLocaleString() : 'never');

async function loadInvites() {
  if (me?.authMode !== 'multiuser') return;
  const box = $('adminInvites');
  let out;
  try { out = await api.get('/api/admin/invites'); }
  catch (err) { box.textContent = err.message; return; }
  box.replaceChildren(...out.invites.map((invite) => {
    const line = el('div', 'admin-row');
    const label = el('div', 'admin-who');
    label.appendChild(Object.assign(el('strong'), { textContent: invite.email || 'Anyone with the link' }));
    label.appendChild(Object.assign(el('span', 'usage'), { textContent: `expires ${fmt(invite.expiresAt)}` }));
    const revoke = Object.assign(el('button'), { type: 'button', textContent: 'revoke' });
    revoke.onclick = async () => {
      try { await api.del(`/api/admin/invites/${encodeURIComponent(invite.id)}`); await loadInvites(); }
      catch (err) { $('inviteResult').textContent = err.message; }
    };
    line.append(label, revoke);
    return line;
  }));
}

function select(value, options, label, onChange) {
  const sel = el('select');
  sel.setAttribute('aria-label', label);
  for (const v of options) sel.appendChild(Object.assign(el('option'), { value: v, textContent: v }));
  sel.value = value;
  sel.onchange = () => onChange(sel);
  return sel;
}

function row(user) {
  const r = el('div', 'admin-row');
  const who = el('div', 'admin-who');
  who.appendChild(Object.assign(el('strong'), { textContent: user.name || user.email || user.id }));
  who.appendChild(Object.assign(el('span', 'usage'), {
    textContent: [user.email, `${user.chatCount ?? 0} chats`, `last seen ${fmt(user.lastLoginAt)}`].filter(Boolean).join(' · ')
  }));
  const err = el('div', 'admin-err');
  const self = me?.user?.id === user.id;

  const patch = async (sel, body, previous) => {
    sel.disabled = true;
    err.textContent = '';
    try {
      const out = await api.patch(`/api/admin/users/${encodeURIComponent(user.id)}`, body);
      Object.assign(user, out.user);
    } catch (e) {
      sel.value = previous;
      err.textContent = e.message;
    } finally {
      sel.disabled = self;
    }
  };

  const status = select(user.status, ['approved', 'pending', 'disabled'], 'Status', (sel) => patch(sel, { status: sel.value }, user.status));
  const role = select(user.role, ['user', 'admin'], 'Role', (sel) => patch(sel, { role: sel.value }, user.role));
  // Your own account can't be demoted or disabled from here -- the server
  // refuses too, but a locked control says so before you try.
  if (self) { status.disabled = true; role.disabled = true; status.title = role.title = 'your own account'; }
  if (user.pinnedInCode) {
    status.disabled = true; role.disabled = true;
    status.title = role.title = `declared in code (${user.pinnedInCode})`;
  }
  const view = Object.assign(el('button'), { type: 'button', textContent: 'chats' });
  view.onclick = () => openUser(user);
  const connectors = Object.assign(el('button'), { type: 'button', textContent: 'connectors' });
  connectors.onclick = () => openUserConnectors(user);
  r.append(who, status, role, view, connectors, err);
  return r;
}

/* ---------- oversight: a user's chats, then one chat, read-only ---------- */

let pollTimer = null;
const stopPoll = () => { if (pollTimer) clearTimeout(pollTimer); pollTimer = null; };

function showView(title, meta) {
  adminViewRequest++;
  stopPoll();
  $('adminUsers').parentElement.hidden = true;
  $('adminPolicy').hidden = true;
  $('adminView').hidden = false;
  $('adminViewTitle').textContent = title;
  $('adminViewMeta').textContent = meta || '';
  const body = $('adminViewBody');
  body.innerHTML = '';
  return body;
}

async function openUser(user) {
  const body = showView(user.name || user.email || user.id, 'loading…');
  $('adminBack').onclick = () => loadAdmin();
  const request = adminViewRequest;
  let out;
  try { out = await api.get(`/api/admin/users/${encodeURIComponent(user.id)}/chats`); }
  catch (e) { if (request === adminViewRequest) $('adminViewMeta').textContent = e.message; return; }
  if (request !== adminViewRequest) return;
  const s = out.summary || {};
  const cost = s.pricedRounds ? ` · $${Number(s.reportedCost || 0).toFixed(2)} reported` : '';
  $('adminViewMeta').textContent = `${out.chats.length} chats · ${s.rounds || 0} model rounds${cost}`;
  for (const c of out.chats) {
    const b = el('button', 'admin-chat');
    b.type = 'button';
    b.append(Object.assign(el('span'), { textContent: c.title || c.id }));
    if (c.running) b.append(Object.assign(el('span', 'admin-live'), { textContent: '● live' }));
    b.append(Object.assign(el('span', 'usage'), { textContent: new Date(c.updated_at).toLocaleString() }));
    b.onclick = () => openChat(c.id, user);
    body.appendChild(b);
  }
  if (!out.chats.length) body.appendChild(Object.assign(el('div', 'empty'), { textContent: 'no chats' }));
}

function messageNode(m) {
  const box = el('div', 'admin-msg');
  const label = m.role === 'tool' ? 'tool result' : m.role;
  box.appendChild(Object.assign(el('div', 'admin-msg-role'), { textContent: label + (m.compacted ? ' (compacted)' : '') }));
  if (m.role === 'tool') {
    const d = el('details');
    d.appendChild(Object.assign(el('summary'), { textContent: `${String(m.content || '').length.toLocaleString()} chars` }));
    d.appendChild(Object.assign(el('pre'), { textContent: m.content || '' }));
    box.appendChild(d);
    return box;
  }
  if (m.content) {
    const b = el('div', 'admin-msg-body');
    b.innerHTML = renderMarkdown(m.content); // renderMarkdown escapes its input
    box.appendChild(b);
  }
  if (m.images?.length) box.appendChild(Object.assign(el('div', 'usage'), { textContent: `${m.images.length} image(s) attached` }));
  for (const call of m.tool_calls || []) {
    const d = el('details');
    d.appendChild(Object.assign(el('summary'), { textContent: `calls ${call.function?.name}` }));
    d.appendChild(Object.assign(el('pre'), { textContent: call.function?.arguments || '' }));
    box.appendChild(d);
  }
  return box;
}

async function openChat(chatId, user) {
  const body = showView('loading…');
  $('adminBack').onclick = () => openUser(user);
  const request = adminViewRequest;
  let out;
  try { out = await api.get(`/api/admin/chats/${encodeURIComponent(chatId)}`); }
  catch (e) { if (request === adminViewRequest) $('adminViewTitle').textContent = e.message; return; }
  if (request !== adminViewRequest) return;
  $('adminViewTitle').textContent = out.title || out.id;
  $('adminViewMeta').textContent = `${out.owner?.email || out.owner?.name || 'no owner'} · ${out.messages.length} messages`
    + (out.running ? ' · live, refreshing' : '');
  for (const doc of out.documents || []) {
    const a = Object.assign(el('a', 'usage'), { textContent: `📎 ${doc.filename}`, href: '#' });
    a.onclick = async (e) => {
      e.preventDefault();
      try {
        const d = await api.get(`/api/admin/documents/${encodeURIComponent(doc.id)}`);
        const w = window.open('', '_blank');
        if (w) { w.document.title = d.filename; w.document.body.appendChild(Object.assign(w.document.createElement('pre'), { textContent: d.content })); }
      } catch (err) { $('adminViewMeta').textContent = err.message; }
    };
    body.append(a, el('br'));
  }
  for (const m of out.messages) if (m.role !== 'system') body.appendChild(messageNode(m));
  // Monitoring a turn in flight: re-read while it runs, and only while this
  // chat is still the one on screen.
  if (out.running) pollTimer = setTimeout(() => { if (request === adminViewRequest && $('admin').classList.contains('open') && !$('adminView').hidden) openChat(chatId, user); }, 4000);
}

/* ---------- oversight: a user's data on per-person connectors, read-only ---------- */

const enc = encodeURIComponent;

async function openUserConnectors(user) {
  const body = showView(`${user.name || user.email || user.id} · connectors`, 'loading…');
  $('adminBack').onclick = () => loadAdmin();
  const request = adminViewRequest;
  let out;
  try { out = await api.get(`/api/admin/users/${enc(user.id)}/integrations`); }
  catch (e) { if (request === adminViewRequest) $('adminViewMeta').textContent = e.message; return; }
  if (request !== adminViewRequest) return;
  $('adminViewMeta').textContent = 'read-only, as this user sees it; every view you open is logged';
  for (const s of out.servers) body.appendChild(connectorBlock(user, s));
  if (!out.servers.length) body.appendChild(Object.assign(el('div', 'empty'), { textContent: 'no connectors' }));
}

function connectorBlock(user, s) {
  const box = el('div', 'admin-connector');
  box.appendChild(Object.assign(el('strong'), { textContent: s.title }));
  if (s.reason) {
    box.appendChild(Object.assign(el('div', 'usage'), { textContent: s.reason }));
    return box;
  }
  // Nothing is read until a view is picked: each read is an audited look.
  const tabs = el('div', 'int-tabs');
  tabs.setAttribute('role', 'tablist');
  const slot = el('div', 'int-view');
  for (const view of s.views) {
    const tab = Object.assign(el('button'), { type: 'button', textContent: view.title });
    tab.setAttribute('role', 'tab');
    tab.onclick = () => {
      for (const t of tabs.children) { t.classList.toggle('active', t === tab); t.setAttribute('aria-selected', String(t === tab)); }
      showConnectorView(slot, view, `/api/admin/users/${enc(user.id)}/integrations/${enc(s.name)}/views/${enc(view.id)}`);
    };
    tabs.appendChild(tab);
  }
  box.append(tabs, slot);
  return box;
}

/* ---------- access policy: what the user role may do ---------- */

function checks(box, name, options, chosen, label = (v) => v) {
  box.replaceChildren(...options.map((v) => {
    const cb = Object.assign(el('input'), { type: 'checkbox', value: v, checked: chosen.includes(v) });
    const l = el('label');
    l.append(cb, ` ${label(v)}`);
    return l;
  }));
}
const picked = (box) => [...box.querySelectorAll('input:checked')].map((i) => i.value);

async function loadPolicy() {
  let p;
  try { p = await api.get('/api/admin/policy'); } catch (err) { $('policyMsg').textContent = err.message; return; }
  const all = (v, list) => (v === '*' ? list : v || []);
  checks($('policyFeatures'), 'features', p.features.filter((f) => f !== 'admin' && f !== 'oversight'), all(p.user.features, p.features));
  $('policyModelsGroup').hidden = !p.models.length;
  checks($('policyModels'), 'models', p.models, all(p.user.models, p.models));
  checks($('policyCustomize'), 'customize', p.customizable, p.customize);
  $('policyNewUsers').value = p.newUsers;
  const locked = p.locked;
  for (const n of $('adminPolicy').querySelectorAll('input,select,button')) n.disabled = locked;
  $('policyMsg').textContent = locked ? 'set in code or frozen: change the files' : '';
  $('policySave').onclick = async () => {
    const models = picked($('policyModels'));
    try {
      await api.post('/api/admin/policy', {
        features: picked($('policyFeatures')),
        // Everything ticked means "no restriction", so a model added later is not silently excluded.
        ...(p.models.length ? { models: models.length === p.models.length ? '*' : models } : {}),
        customize: picked($('policyCustomize')),
        newUsers: $('policyNewUsers').value
      });
      $('policyMsg').textContent = 'saved';
    } catch (err) { $('policyMsg').textContent = err.message; }
  };
}

export async function loadAdmin() {
  const request = ++adminLoadRequest;
  adminViewRequest++;
  stopPoll();
  $('adminView').hidden = true;
  $('adminUsers').parentElement.hidden = false;
  $('adminPolicy').hidden = false;
  loadPolicy();
  loadInvites();
  const box = $('adminUsers');
  $('adminMsg').textContent = '';
  let out;
  try {
    out = await api.get('/api/admin/users');
  } catch (err) {
    if (request === adminLoadRequest) {
      box.innerHTML = '';
      $('adminMsg').textContent = `Couldn't load users: ${err.message}`;
    }
    return;
  }
  if (request !== adminLoadRequest) return;
  box.innerHTML = '';
  $('adminCount').textContent = `${out.users.length} · config ${out.fingerprint}`;
  $('adminCount').title = 'Config fingerprint: compare with `tinywebui fingerprint` on the checked-in files';
  for (const u of out.users) box.appendChild(row(u));
  if (!out.users.length) box.appendChild(Object.assign(el('div', 'empty'), { textContent: 'no users yet' }));
}
