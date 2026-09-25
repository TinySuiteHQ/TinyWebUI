/**
 * Admin panel: the users the gateway (or login) has provisioned, with just
 * enough control to approve, disable or promote them. Shown only to admins;
 * the server enforces the same rule on every /api/admin call regardless.
 */
import { $, el } from './dom.js';
import { renderMarkdown } from './md.js';
import { whoami } from './access.js';

let me = null;

/** Wires Log out for whoever is signed in (nav visibility is access.js's). */
export function initAdmin() {
  me = whoami();
  if (me.logoutUrl || me.authMode === 'single') {
    const btn = $('logout');
    btn.hidden = false;
    btn.onclick = async () => {
      try { await fetch('/api/auth/logout', { method: 'POST' }); } catch { /* going anyway */ }
      // Behind a gateway, the gateway owns the session; ending it is its job.
      if (me.logoutUrl) location.href = me.logoutUrl; else location.reload();
    };
  }
}

const fmt = (ts) => (ts ? new Date(ts).toLocaleString() : 'never');

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
      const res = await fetch(`/api/admin/users/${encodeURIComponent(user.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || String(res.status));
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
  r.append(who, status, role, view, err);
  return r;
}

/* ---------- oversight: a user's chats, then one chat, read-only ---------- */

let pollTimer = null;
const stopPoll = () => { if (pollTimer) clearTimeout(pollTimer); pollTimer = null; };

function showView(title, meta) {
  stopPoll();
  $('adminUsers').parentElement.hidden = true;
  $('adminView').hidden = false;
  $('adminViewTitle').textContent = title;
  $('adminViewMeta').textContent = meta || '';
  const body = $('adminViewBody');
  body.innerHTML = '';
  return body;
}

async function getJson(url) {
  const res = await fetch(url);
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || String(res.status));
  return out;
}

async function openUser(user) {
  const body = showView(user.name || user.email || user.id, 'loading…');
  $('adminBack').onclick = () => loadAdmin();
  let out;
  try { out = await getJson(`/api/admin/users/${encodeURIComponent(user.id)}/chats`); }
  catch (e) { $('adminViewMeta').textContent = e.message; return; }
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
  let out;
  try { out = await getJson(`/api/admin/chats/${encodeURIComponent(chatId)}`); }
  catch (e) { $('adminViewTitle').textContent = e.message; return; }
  $('adminViewTitle').textContent = out.title || out.id;
  $('adminViewMeta').textContent = `${out.owner?.email || out.owner?.name || 'no owner'} · ${out.messages.length} messages`
    + (out.running ? ' · live, refreshing' : '');
  for (const doc of out.documents || []) {
    const a = Object.assign(el('a', 'usage'), { textContent: `📎 ${doc.filename}`, href: '#' });
    a.onclick = async (e) => {
      e.preventDefault();
      try {
        const d = await getJson(`/api/admin/documents/${encodeURIComponent(doc.id)}`);
        const w = window.open('', '_blank');
        if (w) { w.document.title = d.filename; w.document.body.appendChild(Object.assign(w.document.createElement('pre'), { textContent: d.content })); }
      } catch (err) { $('adminViewMeta').textContent = err.message; }
    };
    body.append(a, el('br'));
  }
  for (const m of out.messages) if (m.role !== 'system') body.appendChild(messageNode(m));
  // Monitoring a turn in flight: re-read while it runs, and only while this
  // chat is still the one on screen.
  if (out.running) pollTimer = setTimeout(() => { if ($('admin').classList.contains('open') && !$('adminView').hidden) openChat(chatId, user); }, 4000);
}

export async function loadAdmin() {
  stopPoll();
  $('adminView').hidden = true;
  $('adminUsers').parentElement.hidden = false;
  const box = $('adminUsers');
  $('adminMsg').textContent = '';
  const res = await fetch('/api/admin/users');
  const out = await res.json().catch(() => ({}));
  box.innerHTML = '';
  if (!res.ok) { $('adminMsg').textContent = out.error || `${res.status}`; return; }
  $('adminCount').textContent = `${out.users.length} · config ${out.fingerprint}`;
  $('adminCount').title = 'Config fingerprint: compare with `tinywebui fingerprint` on the checked-in files';
  for (const u of out.users) box.appendChild(row(u));
  if (!out.users.length) box.appendChild(Object.assign(el('div', 'empty'), { textContent: 'no users yet' }));
}
