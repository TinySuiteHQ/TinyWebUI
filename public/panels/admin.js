/**
 * Admin panel: People (who is waiting, who holds which role, who is turned
 * away) and Roles (what each role may do). Shown only to admins; the server
 * enforces the same rule on every /api/admin call regardless. What a person
 * may do is set on their role only, never on the person.
 */
import { $, el } from '../core/dom.js';
import { renderMarkdown } from '../core/md.js';
import { whoami } from '../core/access.js';
import { api } from '../core/api.js';
import { FEATURE } from '../shared/features.js';
import { showView as showConnectorView } from './integrations.js';

let me = null;
let adminLoadRequest = 0;
// Bumped by every admin view change; a response for an older view is dropped.
let adminViewRequest = 0;

// What the panel last loaded, and what the person is looking at.
let users = [];
let policy = null;
let filter = 'all';
let tab = 'people';
let openRole = null;

const enc = encodeURIComponent;

/** 'team-lead' -> 'Team lead': role names are handles, this is how they read. */
const roleLabel = (name) => {
  const words = String(name).replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function ago(ts) {
  if (!ts) return 'never';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return plural(Math.floor(s / 86400), 'day') + ' ago';
  return new Date(ts).toLocaleDateString();
}
const fmt = (ts) => (ts ? new Date(ts).toLocaleString() : 'never');

// The features a role can be given, in the words the Roles tab uses. The
// admin feature is not among them: it belongs to the admin role alone.
const FEATURE_INFO = {
  [FEATURE.CHAT]: ['Chat', 'Talk to the models'],
  [FEATURE.ATTACHMENTS]: ['Attach files', 'Add documents to a chat'],
  [FEATURE.IMAGES]: ['Images', 'Send pictures to models that can see'],
  [FEATURE.SEARCH]: ['Search', 'Search their past chats'],
  [FEATURE.FOLDERS]: ['Folders', 'Sort chats into folders'],
  [FEATURE.MODEL_PICKER]: ['Pick a model', 'Choose among the models allowed below'],
  [FEATURE.TOOLS]: ['Tools menu', 'Turn tools on and off from the composer'],
  [FEATURE.AUTOMATIONS]: ['Automations', 'Schedule prompts that run on their own'],
  [FEATURE.STATISTICS]: ['Statistics', 'See their own usage and cost'],
  [FEATURE.INTEGRATIONS]: ['Integrations', 'Their own data in connected services'],
  [FEATURE.SETTINGS]: ['Settings', 'Change shared settings (never keys or endpoints)'],
  [FEATURE.MCP]: ['MCP servers', 'Add and edit tool servers for everyone'],
  [FEATURE.OVERSIGHT]: ['Oversight', "Read other people's chats; every look is audited"]
};
const FEATURE_GROUPS = [
  ['In a chat', [FEATURE.CHAT, FEATURE.ATTACHMENTS, FEATURE.IMAGES, FEATURE.SEARCH, FEATURE.FOLDERS, FEATURE.MODEL_PICKER, FEATURE.TOOLS]],
  ['Their own space', [FEATURE.AUTOMATIONS, FEATURE.STATISTICS, FEATURE.INTEGRATIONS]],
  ['Running the place', [FEATURE.SETTINGS, FEATURE.MCP, FEATURE.OVERSIGHT]]
];
const CUSTOMIZE_INFO = { theme: ['Theme', 'Pick their own look'], instructions: ['Personal instructions', 'Add their own instructions for the model'] };
const featureName = (f) => FEATURE_INFO[f]?.[0] || f;

const text = (tag, cls, value) => Object.assign(el(tag, cls), { textContent: value });
const button = (label, cls, onclick) => Object.assign(el('button', cls), { type: 'button', textContent: label, onclick });

/** Wires the tabs, invitations, and Log out for whoever is signed in (nav visibility is core/access.js's). */
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
  $('adminTabPeople').onclick = () => showTab('people');
  $('adminTabRoles').onclick = () => showTab('roles');
  $('adminSearch').oninput = () => renderPeople();
  $('roleNew').onsubmit = createRole;
  if (me.authMode === 'multiuser') {
    $('adminInviteToggle').hidden = false;
    $('adminInviteToggle').onclick = () => {
      const form = $('adminInvite');
      form.hidden = !form.hidden;
      $('adminInviteToggle').setAttribute('aria-expanded', String(!form.hidden));
      if (!form.hidden) { loadInvites(); $('inviteEmail').focus(); }
    };
    $('adminInvite').onsubmit = async (event) => {
      event.preventDefault();
      const result = $('inviteResult');
      result.textContent = '';
      try {
        const out = await api.post('/api/admin/invites', { email: $('inviteEmail').value.trim() || null });
        const url = new URL(out.path, location.origin).href;
        const link = Object.assign(el('a'), { href: url, textContent: url });
        const copy = button('Copy', 'adm-small', async () => {
          try { await navigator.clipboard.writeText(url); copy.textContent = 'Copied'; } catch { copy.textContent = 'Select and copy it'; }
        });
        result.replaceChildren('Share this link once: ', link, ' ', copy);
        $('inviteEmail').value = '';
        await loadInvites();
      } catch (err) { result.textContent = err.message; }
    };
  }
  // Someone waiting should not depend on an admin happening to open the panel.
  if (me.features?.includes(FEATURE.ADMIN) && ['multiuser', 'trusted-header'].includes(me.authMode)) {
    api.get('/api/admin/users').then((out) => markWaiting(out.users), () => {});
  }
}

function markWaiting(list) {
  const n = list.filter((u) => u.status === 'pending').length;
  for (const id of ['adminWaitingBadge', 'adminNavBadge']) {
    const badge = $(id);
    if (!badge) continue;
    badge.hidden = !n;
    badge.textContent = String(n);
    badge.title = `${plural(n, 'person', 'people')} waiting for approval`;
  }
}

function showTab(name) {
  tab = name;
  adminViewRequest++;
  stopPoll();
  $('adminView').hidden = true;
  for (const [id, panel] of [['adminTabPeople', 'adminPeople'], ['adminTabRoles', 'adminRoles']]) {
    const on = panel === (name === 'people' ? 'adminPeople' : 'adminRoles');
    $(id).classList.toggle('active', on);
    $(id).setAttribute('aria-selected', String(on));
    $(panel).hidden = !on;
  }
}

async function loadInvites() {
  if (me?.authMode !== 'multiuser') return;
  const box = $('adminInvites');
  let out;
  try { out = await api.get('/api/admin/invites'); }
  catch (err) { box.textContent = err.message; return; }
  box.replaceChildren(...out.invites.map((invite) => {
    const line = el('div', 'adm-invite-item');
    const label = el('div', 'adm-who');
    label.append(text('strong', '', invite.email || 'Anyone with the link'), text('span', 'adm-meta', `expires ${fmt(invite.expiresAt)}`));
    const revoke = button('Revoke', 'adm-small', async () => {
      try { await api.del(`/api/admin/invites/${enc(invite.id)}`); await loadInvites(); }
      catch (err) { $('inviteResult').textContent = err.message; }
    });
    line.append(label, revoke);
    return line;
  }));
  if (out.invites.length) box.prepend(text('div', 'adm-sub', 'Open invitations'));
}

/* ---------- people ---------- */

const roles = () => policy?.roles?.map((r) => r.name) || ['admin', 'user'];

function roleSelect(value, label, onChange) {
  const sel = el('select', 'adm-role');
  sel.setAttribute('aria-label', label);
  const names = roles();
  // A role removed from the files by hand still shows as what the person holds.
  for (const v of names.includes(value) ? names : [...names, value]) {
    sel.appendChild(Object.assign(el('option'), { value: v, textContent: names.includes(v) ? roleLabel(v) : `${v} (no longer defined)` }));
  }
  sel.value = value;
  sel.onchange = () => onChange(sel);
  return sel;
}

function avatar(user) {
  const name = user.name || user.email || '?';
  const a = text('span', 'adm-avatar', name.trim().charAt(0).toUpperCase() || '?');
  a.setAttribute('aria-hidden', 'true');
  return a;
}

function personRow(user) {
  const r = el('div', `adm-person ${user.status}`);
  const who = el('div', 'adm-who');
  const top = el('div', 'adm-name');
  top.appendChild(text('strong', '', user.name || user.email || user.id));
  const self = me?.user?.id === user.id;
  if (self) top.appendChild(text('span', 'chip', 'you'));
  if (user.pinnedInCode) {
    const chip = text('span', 'chip', 'set in config');
    chip.title = `Declared in tinywebui.config.js (${user.pinnedInCode}); change it there.`;
    top.appendChild(chip);
  }
  const meta = user.status === 'pending'
    ? [user.name && user.email, `asked ${ago(user.createdAt)}`]
    : [user.name && user.email, plural(user.chatCount ?? 0, 'chat'), `seen ${ago(user.lastLoginAt)}`];
  who.append(top, text('span', 'adm-meta', meta.filter(Boolean).join(' · ')));
  const err = text('div', 'adm-err', '');
  err.setAttribute('role', 'alert');
  // Your own account can't be demoted or disabled from here -- the server
  // refuses too, but a locked control says so before you try.
  const locked = self || Boolean(user.pinnedInCode);

  const patch = async (controls, body) => {
    for (const c of controls) c.disabled = true;
    err.textContent = '';
    try {
      const out = await api.patch(`/api/admin/users/${enc(user.id)}`, body);
      Object.assign(user, out.user);
      renderPeople();
      // A role's head count on the Roles tab moves with every change here.
      refreshPolicy();
    } catch (e) {
      err.textContent = e.message;
      for (const c of controls) c.disabled = false;
    }
  };

  const actions = el('div', 'adm-actions');
  if (user.status === 'pending') {
    const role = roleSelect(user.role, `Role for ${user.name || user.email || 'this person'}`, () => {});
    const approve = button('Approve', 'primary', () => patch([role, approve, deny], { status: 'approved', role: role.value }));
    const deny = button('Turn away', 'adm-quiet', () => patch([role, approve, deny], { status: 'disabled' }));
    const as = text('label', 'adm-as', 'as');
    as.htmlFor = role.id = `adm-role-${user.id}`;
    actions.append(as, role, approve, deny);
    if (locked) for (const c of [role, approve, deny]) c.disabled = true;
  } else if (user.status === 'disabled') {
    const restore = button('Restore access', '', () => patch([restore], { status: 'approved' }));
    restore.disabled = locked;
    actions.append(text('span', 'adm-meta', roleLabel(user.role)), restore);
  } else {
    const role = roleSelect(user.role, `Role for ${user.name || user.email || 'this person'}`, (sel) => patch([sel], { role: sel.value }));
    role.disabled = locked;
    const chats = button('Chats', 'adm-small', () => openUser(user));
    const connectors = button('Connectors', 'adm-small', () => openUserConnectors(user));
    const off = button('Disable', 'adm-small adm-quiet', () => {
      if (confirm(`Turn off access for ${user.name || user.email || 'this person'}? They are signed out at once; you can restore it later.`)) patch([off], { status: 'disabled' });
    });
    off.disabled = locked;
    actions.append(role, chats, connectors);
    // Local accounts only: a gateway (SSO) account has no password here. Your own is under My preferences.
    if (user.hasPassword && !self) actions.appendChild(button('Set password', 'adm-small', () => togglePasswordForm(r, user)));
    actions.appendChild(off);
  }
  if (locked) actions.title = self ? 'This is your own account' : `Declared in code (${user.pinnedInCode})`;
  r.append(avatar(user), who, actions, err);
  return r;
}

/**
 * An admin choosing a new password for someone who cannot sign in. Typed
 * twice, held to the same rule as every password, and it signs them out
 * everywhere: they sign in again with the new one.
 */
function togglePasswordForm(row, user) {
  const open = row.querySelector('.adm-pw');
  if (open) { open.remove(); return; }
  const form = el('form', 'adm-pw');
  const min = whoami().passwordMin;
  const field = (label) => {
    const input = Object.assign(el('input'), { type: 'password', autocomplete: 'new-password', required: true, minLength: min, placeholder: label });
    input.setAttribute('aria-label', label);
    return input;
  };
  const pw = field('New password');
  const again = field('Confirm new password');
  const save = Object.assign(el('button', 'primary'), { type: 'submit', textContent: 'Set password' });
  const msg = text('div', 'adm-err', '');
  msg.setAttribute('role', 'alert');
  form.append(pw, again, save, button('Cancel', '', () => form.remove()), text('div', 'adm-meta adm-pw-rule', `At least ${min} characters. ${user.name || user.email || 'They'} will be signed out everywhere.`), msg);
  form.onsubmit = async (event) => {
    event.preventDefault();
    msg.textContent = '';
    if (pw.value !== again.value) { msg.textContent = 'The two passwords do not match.'; again.select(); return; }
    save.disabled = true;
    try {
      await api.post(`/api/admin/users/${enc(user.id)}/password`, { password: pw.value });
      form.replaceChildren(text('div', 'adm-meta adm-pw-done', `Password set. Let ${user.name || user.email || 'them'} know the new one; they were signed out.`));
      setTimeout(() => form.remove(), 6000);
    } catch (err) { msg.textContent = err.message; save.disabled = false; }
  };
  row.appendChild(form);
  pw.focus();
}

/** Who goes in which group, in the order the panel shows them. */
function groups() {
  const out = [{ key: 'pending', title: 'Waiting for approval', note: 'New sign-ups. Approve each into a role, or turn them away.', people: [] }];
  const byRole = new Map();
  for (const name of roles()) {
    const g = { key: `role:${name}`, title: { admin: 'Admins', user: 'Users' }[name] || roleLabel(name), people: [] };
    byRole.set(name, g);
    out.push(g);
  }
  const disabled = { key: 'disabled', title: 'Access turned off', note: 'They cannot sign in. Their chats are kept.', people: [] };
  for (const u of users) {
    if (u.status === 'pending') out[0].people.push(u);
    else if (u.status === 'disabled') disabled.people.push(u);
    else {
      if (!byRole.has(u.role)) {
        const g = { key: `role:${u.role}`, title: `${u.role} (role no longer defined)`, people: [] };
        byRole.set(u.role, g);
        out.push(g);
      }
      byRole.get(u.role).people.push(u);
    }
  }
  out.push(disabled);
  return out;
}

function renderPeople() {
  const all = groups();
  if (!all.some((g) => g.key === filter)) filter = 'all';
  const chip = (key, label, n) => {
    const b = button('', `adm-filter${filter === key ? ' active' : ''}${key === 'pending' && n ? ' waiting' : ''}`, () => { filter = key; renderPeople(); });
    b.setAttribute('aria-pressed', String(filter === key));
    b.append(text('span', '', label), text('span', 'adm-count', String(n)));
    return b;
  };
  $('adminFilters').replaceChildren(
    chip('all', 'Everyone', users.length),
    ...all.filter((g) => g.people.length || g.key === 'pending' || g.key.startsWith('role:')).map((g) => chip(g.key, g.key === 'pending' ? 'Waiting' : g.title, g.people.length))
  );
  markWaiting(users);
  const q = $('adminSearch').value.trim().toLowerCase();
  const match = (u) => !q || [u.name, u.email, u.id].some((v) => v && String(v).toLowerCase().includes(q));
  const box = $('adminUsers');
  box.replaceChildren();
  for (const g of all) {
    if (filter !== 'all' && filter !== g.key) continue;
    const people = g.people.filter(match);
    // Empty groups are noise in the overview; a group picked on purpose says it is empty.
    if (!people.length && filter === 'all') continue;
    const section = el('section', `adm-group${g.key === 'pending' ? ' waiting' : ''}`);
    const head = el('div', 'adm-group-h');
    head.append(text('h3', '', g.title), text('span', 'adm-count', String(people.length)));
    section.appendChild(head);
    if (g.note) section.appendChild(text('p', 'adm-note', g.note));
    for (const u of people) section.appendChild(personRow(u));
    if (!people.length) section.appendChild(text('div', 'empty', q ? 'Nobody here matches.' : g.key === 'pending' ? 'Nobody is waiting.' : 'Nobody here yet.'));
    box.appendChild(section);
  }
  if (!box.children.length) box.appendChild(text('div', 'empty', q ? 'Nobody matches.' : 'No one has signed in yet.'));
}

/* ---------- roles ---------- */

function roleSummary(r) {
  if (r.fixed) return 'Everything, always, including this panel.';
  const shown = r.features.filter((f) => f !== FEATURE.ADMIN).map(featureName);
  if (!shown.length) return 'Nothing yet: tick what this role may use.';
  return shown.length > 5 ? `${shown.slice(0, 5).join(', ')} and ${shown.length - 5} more` : shown.join(', ');
}

function checkCard(value, [label, note], checked, disabled) {
  const l = el('label', 'adm-check');
  const cb = Object.assign(el('input'), { type: 'checkbox', value, checked, disabled });
  const words = el('span');
  words.append(text('b', '', label), text('small', '', note));
  l.append(cb, words);
  return l;
}
const picked = (box) => [...box.querySelectorAll('input:checked')].map((i) => i.value);

function roleEditor(r) {
  const form = el('form', 'adm-role-edit');
  const locked = policy.locked;
  const grouped = new Set(FEATURE_GROUPS.flatMap(([, list]) => list));
  // Features the page has no words for still show, so a newer server's are editable too.
  const others = policy.features.filter((f) => !grouped.has(f) && f !== FEATURE.ADMIN);
  const featureBox = el('div', 'adm-feature-groups');
  for (const [title, list] of [...FEATURE_GROUPS, ...(others.length ? [['Other', others]] : [])]) {
    const set = el('fieldset', 'adm-fieldset');
    set.appendChild(text('legend', '', title));
    const grid = el('div', 'adm-checks');
    for (const f of list.filter((x) => policy.features.includes(x))) {
      grid.appendChild(checkCard(f, FEATURE_INFO[f] || [f, ''], r.features.includes(f), locked));
    }
    set.appendChild(grid);
    featureBox.appendChild(set);
  }
  form.appendChild(featureBox);

  let modelBox = null;
  let anyModel = null;
  if (policy.models.length) {
    const set = el('fieldset', 'adm-fieldset');
    set.appendChild(text('legend', '', 'Models'));
    const any = checkCard('*', ['Any model', 'Including ones added later'], r.models === '*', locked);
    anyModel = any.querySelector('input');
    modelBox = el('div', 'adm-checks adm-models');
    for (const m of policy.models) {
      modelBox.appendChild(checkCard(m, [m, ''], r.models === '*' || r.models.includes(m), locked || r.models === '*'));
    }
    anyModel.onchange = () => {
      for (const cb of modelBox.querySelectorAll('input')) { cb.disabled = locked || anyModel.checked; if (anyModel.checked) cb.checked = true; }
    };
    set.append(any, modelBox);
    form.appendChild(set);
  }

  const customize = el('fieldset', 'adm-fieldset');
  customize.appendChild(text('legend', '', 'They may personalise'));
  const customizeBox = el('div', 'adm-checks');
  for (const c of policy.customizable) customizeBox.appendChild(checkCard(c, CUSTOMIZE_INFO[c] || [c, ''], r.customize.includes(c), locked));
  customize.appendChild(customizeBox);
  form.appendChild(customize);

  const msg = text('div', 'usage adm-err', '');
  msg.setAttribute('role', 'alert');
  const bar = el('div', 'adm-role-bar');
  const save = Object.assign(el('button', 'primary'), { type: 'submit', textContent: 'Save changes', disabled: locked });
  const cancel = button('Cancel', '', () => { openRole = null; renderRoles(); });
  bar.append(save, cancel);
  if (!r.builtin) {
    const del = button('Delete role', 'adm-quiet adm-delete', async () => {
      const moving = r.users ? ` ${plural(r.users, 'person', 'people')} with it will move to User.` : '';
      if (!confirm(`Delete the ${roleLabel(r.name)} role?${moving}`)) return;
      try {
        const out = await api.del(`/api/admin/roles/${enc(r.name)}`);
        policy.roles = out.roles;
        openRole = null;
        renderRoles();
        loadAdmin();
      } catch (err) { msg.textContent = err.message; }
    });
    del.disabled = locked;
    bar.appendChild(del);
  }
  form.append(bar, msg);
  form.onsubmit = async (event) => {
    event.preventDefault();
    msg.textContent = '';
    // Features this editor does not offer (admin, set in the files) are kept as they were.
    const kept = r.features.filter((f) => !FEATURE_INFO[f] && !others.includes(f));
    const body = { features: [...picked(featureBox), ...kept], customize: picked(customizeBox) };
    if (modelBox) body.models = anyModel.checked ? '*' : picked(modelBox);
    save.disabled = true;
    try {
      const out = await api.patch(`/api/admin/roles/${enc(r.name)}`, body);
      policy.roles = out.roles;
      openRole = null;
      renderRoles();
      $('rolesMsg').textContent = `Saved ${roleLabel(r.name)}.`;
    } catch (err) { msg.textContent = err.message; save.disabled = false; }
  };
  return form;
}

function renderRoles() {
  if (!policy) return;
  const list = $('roleList');
  list.replaceChildren();
  for (const r of policy.roles) {
    const card = el('article', `adm-role-card${openRole === r.name ? ' open' : ''}`);
    const head = el('div', 'adm-role-h');
    const title = el('div', 'adm-role-title');
    title.append(text('h3', '', roleLabel(r.name)), text('span', 'chip', r.builtin ? 'built in' : 'custom'));
    const people = button(plural(r.users, 'person', 'people'), 'adm-link', () => {
      filter = r.users ? `role:${r.name}` : 'all';
      showTab('people');
      renderPeople();
    });
    people.disabled = !r.users;
    head.append(title, people);
    if (!r.fixed && openRole !== r.name) {
      const edit = button('Edit', 'adm-small', () => { openRole = r.name; renderRoles(); });
      edit.disabled = policy.locked;
      head.appendChild(edit);
    }
    card.append(head);
    if (openRole === r.name) card.appendChild(roleEditor(r));
    else {
      card.appendChild(text('p', 'adm-role-sum', roleSummary(r)));
      if (!r.fixed && policy.models.length) {
        card.appendChild(text('p', 'adm-meta', r.models === '*' ? 'Any model' : r.models.length ? `Models: ${r.models.join(', ')}` : 'No models'));
      }
    }
    list.appendChild(card);
  }
  $('roleNew').hidden = policy.locked;
  if (policy.locked) $('rolesMsg').textContent = 'Roles are set in tinywebui.config.js or the config is frozen: change them in the files.';
  const from = $('roleNewFrom');
  const keep = from.value || 'user';
  from.replaceChildren(
    ...policy.roles.filter((r) => !r.fixed).map((r) => Object.assign(el('option'), { value: r.name, textContent: `Copy of ${roleLabel(r.name)}` })),
    Object.assign(el('option'), { value: '', textContent: 'Start empty' })
  );
  from.value = [...from.options].some((o) => o.value === keep) ? keep : 'user';
}

async function createRole(event) {
  event.preventDefault();
  $('rolesMsg').textContent = '';
  const name = $('roleNewName').value.trim().toLowerCase();
  const base = policy?.roles.find((r) => r.name === $('roleNewFrom').value);
  const body = base
    ? { name, features: base.features.filter((f) => f !== FEATURE.ADMIN), customize: base.customize, ...(policy.models.length ? { models: base.models } : {}) }
    : { name, features: [], customize: [] };
  try {
    const out = await api.post('/api/admin/roles', body);
    policy.roles = out.roles;
    $('roleNewName').value = '';
    openRole = name;
    renderRoles();
  } catch (err) { $('rolesMsg').textContent = err.message; }
}

/* ---------- oversight: a user's chats, then one chat, read-only ---------- */

let pollTimer = null;
const stopPoll = () => { if (pollTimer) clearTimeout(pollTimer); pollTimer = null; };

function showView(title, meta) {
  adminViewRequest++;
  stopPoll();
  $('adminPeople').hidden = true;
  $('adminRoles').hidden = true;
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

/* ---------- loading ---------- */

async function refreshPolicy() {
  try { policy = await api.get('/api/admin/policy'); } catch (err) { $('rolesMsg').textContent = err.message; return; }
  renderRoles();
}

export async function loadAdmin() {
  const request = ++adminLoadRequest;
  showTab(tab);
  $('adminMsg').textContent = '';
  const [usersOut, policyOut] = await Promise.allSettled([api.get('/api/admin/users'), api.get('/api/admin/policy')]);
  if (request !== adminLoadRequest) return;
  if (policyOut.status === 'fulfilled') { policy = policyOut.value; renderRoles(); }
  else $('rolesMsg').textContent = policyOut.reason.message;
  if (usersOut.status === 'rejected') {
    $('adminUsers').replaceChildren();
    $('adminMsg').textContent = `Couldn't load people: ${usersOut.reason.message}`;
    return;
  }
  users = usersOut.value.users;
  renderPeople();
  const joining = me.authMode === 'multiuser' ? 'People join by invitation; the invitation is the approval.'
    : policy?.newUsers === 'approved' ? 'New sign-ups are let in straight away (access.newUsers in the config file).'
      : 'New sign-ups wait here until an admin approves them.';
  $('adminFoot').textContent = `${joining} · Config ${usersOut.value.fingerprint}`;
  $('adminFoot').title = 'Config fingerprint: compare with `tinywebui fingerprint` on the checked-in files';
  if (!$('adminInvite').hidden) loadInvites();
}
