/**
 * Admin panel: the users the gateway (or login) has provisioned, with just
 * enough control to approve, disable or promote them. Shown only to admins;
 * the server enforces the same rule on every /api/admin call regardless.
 */
import { $, el } from './dom.js';

let me = null;

/** Reveals the Admin and Log out nav items for whoever is signed in. */
export async function initAdmin() {
  try { me = await (await fetch('/api/auth/me')).json(); } catch { return; }
  $('toggle-admin').hidden = !(me.isAdmin && me.authMode !== 'none');
  if (me.logoutUrl) {
    const btn = $('logout');
    btn.hidden = false;
    btn.onclick = async () => {
      // The upstream gateway owns the session; ending it is its job.
      try { await fetch('/api/auth/logout', { method: 'POST' }); } catch { /* going anyway */ }
      location.href = me.logoutUrl;
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
  r.append(who, status, role, err);
  return r;
}

export async function loadAdmin() {
  const box = $('adminUsers');
  $('adminMsg').textContent = '';
  const res = await fetch('/api/admin/users');
  const out = await res.json().catch(() => ({}));
  box.innerHTML = '';
  if (!res.ok) { $('adminMsg').textContent = out.error || `${res.status}`; return; }
  $('adminCount').textContent = `${out.users.length}`;
  for (const u of out.users) box.appendChild(row(u));
  if (!out.users.length) box.appendChild(Object.assign(el('div', 'empty'), { textContent: 'no users yet' }));
}
