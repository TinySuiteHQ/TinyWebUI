<script setup lang="ts">
/**
 * People (who is waiting, who holds which role, who is turned away) and Roles
 * (what each role may do). Shown only to admins; the server enforces the same
 * rule on every /api/admin call. What a person may do is set on their role
 * only, never on the person.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { api } from '../../core/api.ts';
import { FEATURE } from '../../../../shared/features.ts';
import { useSession } from '../../stores/session.ts';
import { useAdmin } from '../../stores/admin.ts';
import { PANEL } from '../../stores/panels.ts';
import { usePanel } from '../usePanel.ts';
import { featureName, plural, roleLabel, roleSettingsSummary, when } from './admin_words.ts';
import PersonRow from './PersonRow.vue';
import RoleEditor from './RoleEditor.vue';
import IntegrationView from '../mcp/IntegrationView.vue';
import Markdown from '../../chat/Markdown.vue';

// /api/admin/* replies, read field by field.
type Json = any;
const session = useSession();
const admin = useAdmin();
const me = computed(() => session.me);
const enc = encodeURIComponent;

const tab = ref<'people' | 'roles'>('people');
const users = ref<Json[]>([]);
const policy = ref<Json | null>(null);
const fingerprint = ref('');
const filter = ref('all');
const search = ref('');
const msg = ref('');
const rolesMsg = ref('');
const openRole = ref<string | null>(null);
const newRole = ref('');
const newRoleFrom = ref('user');
let loadRequest = 0;

/* ---------- people ---------- */

const roleNames = computed<string[]>(() => policy.value?.roles?.map((r: Json) => r.name) || ['admin', 'user']);

type Group = { key: string, title: string, note?: string, people: Json[] };
/** Who goes in which group, in the order the panel shows them. */
const groups = computed<Group[]>(() => {
  const out: Group[] = [{ key: 'pending', title: 'Waiting for approval', note: 'New sign-ups and access requests. Approve each into a role, or turn them away.', people: [] }];
  const byRole = new Map<string, Group>();
  for (const name of roleNames.value) {
    const g = { key: `role:${name}`, title: ({ admin: 'Admins', user: 'Users' } as Record<string, string>)[name] || roleLabel(name), people: [] };
    byRole.set(name, g);
    out.push(g);
  }
  const disabled: Group = { key: 'disabled', title: 'Access turned off', note: 'They cannot sign in. Their chats are kept.', people: [] };
  for (const u of users.value) {
    if (u.status === 'pending') out[0]?.people.push(u);
    else if (u.status === 'disabled') disabled.people.push(u);
    else {
      let g = byRole.get(u.role);
      if (!g) {
        g = { key: `role:${u.role}`, title: `${u.role} (role no longer defined)`, people: [] };
        byRole.set(u.role, g);
        out.push(g);
      }
      g.people.push(u);
    }
  }
  out.push(disabled);
  return out;
});
const chips = computed(() => [{ key: 'all', label: 'Everyone', n: users.value.length },
  ...groups.value.filter((g) => g.people.length || g.key === 'pending' || g.key.startsWith('role:'))
    .map((g) => ({ key: g.key, label: g.key === 'pending' ? 'Waiting' : g.title, n: g.people.length }))]);
const match = (u: Json) => {
  const q = search.value.trim().toLowerCase();
  return !q || [u.name, u.email, u.id].some((v) => v && String(v).toLowerCase().includes(q));
};
const shownGroups = computed(() => groups.value
  .filter((g) => filter.value === 'all' || filter.value === g.key)
  .map((g) => ({ ...g, people: g.people.filter(match) }))
  // Empty groups are noise in the overview; a group picked on purpose says it is empty.
  .filter((g) => g.people.length || filter.value !== 'all'));

function changed(user: Json, next: Json) {
  Object.assign(user, next);
  admin.markWaiting(users.value);
  // A role's head count on the Roles tab moves with every change here.
  refreshPolicy();
}

/* ---------- invitations ---------- */

const inviteOpen = ref(false);
const inviteEmail = ref('');
const inviteResult = ref('');
const inviteUrl = ref('');
const copied = ref(false);
const invites = ref<Json[]>([]);

async function loadInvites() {
  if (me.value.authMode !== 'multiuser') return;
  try { invites.value = (await api.get('/api/admin/invites')).invites; } catch (err) { inviteResult.value = err.message; }
}
function toggleInvite() {
  inviteOpen.value = !inviteOpen.value;
  if (inviteOpen.value) loadInvites();
}
async function createInvite() {
  inviteResult.value = '';
  inviteUrl.value = '';
  try {
    const out = await api.post('/api/admin/invites', { email: inviteEmail.value.trim() || null });
    inviteUrl.value = new URL(out.path, location.origin).href;
    inviteEmail.value = '';
    copied.value = false;
    await loadInvites();
  } catch (err) { inviteResult.value = err.message; }
}
async function copyInvite() {
  try { await navigator.clipboard.writeText(inviteUrl.value); copied.value = true; } catch { inviteResult.value = 'Select and copy it'; }
}
async function revoke(id: string) {
  try { await api.del(`/api/admin/invites/${enc(id)}`); await loadInvites(); } catch (err) { inviteResult.value = err.message; }
}

async function setRequests(on: boolean) {
  msg.value = '';
  try {
    const out = await api.patch('/api/admin/policy', { allowRequests: on });
    if (policy.value) policy.value.allowRequests = out.allowRequests;
  } catch (err) { msg.value = err.message; }
}

/** How people get in, and the config fingerprint to compare with the checked-in files. */
const foot = computed(() => {
  const joining = me.value.authMode === 'multiuser'
    ? policy.value?.allowRequests ? 'People join by invitation, or ask from the sign-in page and wait for approval.' : 'People join by invitation; the invitation is the approval.'
    : policy.value?.newUsers === 'approved' ? 'New sign-ups are let in straight away (access.newUsers in the config file).'
      : 'New sign-ups wait here until an admin approves them.';
  return `${joining} · Config ${fingerprint.value}`;
});

/* ---------- roles ---------- */

function roleSummary(r: Json) {
  if (r.fixed) return 'Everything, always, including this panel.';
  const shown = r.features.filter((f: string) => f !== FEATURE.ADMIN).map(featureName);
  if (!shown.length) return 'Nothing yet: tick what this role may use.';
  return shown.length > 5 ? `${shown.slice(0, 5).join(', ')} and ${shown.length - 5} more` : shown.join(', ');
}
function showPeopleOf(r: Json) {
  filter.value = r.users ? `role:${r.name}` : 'all';
  tab.value = 'people';
}
async function createRole() {
  rolesMsg.value = '';
  const name = newRole.value.trim().toLowerCase();
  const base = policy.value?.roles.find((r: Json) => r.name === newRoleFrom.value);
  const body = base
    ? { name, features: base.features.filter((f: string) => f !== FEATURE.ADMIN), customize: base.customize, ...(base.settings ? { settings: base.settings } : {}), ...(policy.value.models.length ? { models: base.models } : {}) }
    : { name, features: [], customize: [] };
  try {
    const out = await api.post('/api/admin/roles', body);
    policy.value.roles = out.roles;
    newRole.value = '';
    openRole.value = name;
  } catch (err) { rolesMsg.value = err.message; }
}
function roleSaved(roles: Json[], message: string) { policy.value.roles = roles; openRole.value = null; rolesMsg.value = message; }
function roleDeleted(roles: Json[]) { policy.value.roles = roles; openRole.value = null; load(); }

async function refreshPolicy() {
  try { policy.value = await api.get('/api/admin/policy'); } catch (err) { rolesMsg.value = err.message; }
}

/* ---------- oversight: read-only views of one person's chats and connectors ---------- */

type View = { kind: 'chats', user: Json, data: Json | null } | { kind: 'chat', user: Json, chatId: string, data: Json | null }
  | { kind: 'connectors', user: Json, data: Json | null };
const view = ref<View | null>(null);
const viewError = ref('');
const connectorTab = ref<Record<string, string>>({});
// Bumped by every view change; a response for an older view is dropped.
let viewRequest = 0;
let poll: ReturnType<typeof setTimeout> | undefined;
const stopPoll = () => { clearTimeout(poll); poll = undefined; };
const who = (u: Json) => u.name || u.email || u.id;

async function openView(next: View, url: string) {
  stopPoll();
  const request = ++viewRequest;
  view.value = next;
  viewError.value = '';
  try {
    const out = await api.get(url);
    if (request !== viewRequest) return;
    next.data = out;
    view.value = { ...next };
    // Monitoring a turn in flight: re-read while it runs, and only while this chat is on screen.
    if (next.kind === 'chat' && out.running) poll = setTimeout(() => { if (request === viewRequest && isOpen.value) openChat(next.user, next.chatId); }, 4000);
  } catch (err) {
    if (request === viewRequest) viewError.value = err.message;
  }
}
const openChats = (user: Json) => openView({ kind: 'chats', user, data: null }, `/api/admin/users/${enc(user.id)}/chats`);
const openChat = (user: Json, chatId: string) => openView({ kind: 'chat', user, chatId, data: view.value?.kind === 'chat' && view.value.chatId === chatId ? view.value.data : null }, `/api/admin/chats/${enc(chatId)}`);
const openConnectors = (user: Json) => { connectorTab.value = {}; openView({ kind: 'connectors', user, data: null }, `/api/admin/users/${enc(user.id)}/integrations`); };
function back() {
  const v = view.value;
  if (v?.kind === 'chat') openChats(v.user);
  else { stopPoll(); viewRequest++; view.value = null; load(); }
}
async function openDocument(id: string) {
  try {
    const d = await api.get(`/api/admin/documents/${enc(id)}`);
    const w = window.open('', '_blank');
    if (w) { w.document.title = d.filename; w.document.body.appendChild(Object.assign(w.document.createElement('pre'), { textContent: d.content })); }
  } catch (err) { viewError.value = err.message; }
}
const viewTitle = computed(() => {
  const v = view.value;
  if (!v) return '';
  if (v.kind === 'chat') return v.data ? v.data.title || v.data.id : 'loading…';
  return v.kind === 'connectors' ? `${who(v.user)} · connectors` : who(v.user);
});
const viewMeta = computed(() => {
  const v = view.value;
  if (viewError.value) return viewError.value;
  if (!v?.data) return 'loading…';
  if (v.kind === 'chats') {
    const s = v.data.summary || {};
    const cost = s.pricedRounds ? ` · $${Number(s.reportedCost || 0).toFixed(2)} reported` : '';
    return `${v.data.chats.length} chats · ${s.rounds || 0} model rounds${cost}`;
  }
  if (v.kind === 'chat') return `${v.data.owner?.email || v.data.owner?.name || 'no owner'} · ${v.data.messages.length} messages${v.data.running ? ' · live, refreshing' : ''}`;
  return 'read-only, as this user sees it; every view you open is logged';
});

/* ---------- loading ---------- */

async function load() {
  const request = ++loadRequest;
  msg.value = '';
  const [u, p] = await Promise.allSettled([api.get('/api/admin/users'), api.get('/api/admin/policy')]);
  if (request !== loadRequest) return;
  if (p.status === 'fulfilled') policy.value = p.value;
  else rolesMsg.value = p.reason.message;
  if (u.status === 'rejected') { users.value = []; msg.value = `Couldn't load people: ${u.reason.message}`; return; }
  users.value = u.value.users;
  fingerprint.value = u.value.fingerprint;
  admin.markWaiting(users.value);
  if (!chips.value.some((c) => c.key === filter.value)) filter.value = 'all';
  if (inviteOpen.value) loadInvites();
}

const { isOpen } = usePanel(PANEL.ADMIN, { onOpen: () => { view.value = null; return load(); } });

onMounted(() => {
  // Someone waiting should not depend on an admin happening to open the panel.
  if (session.can(FEATURE.ADMIN) && ['multiuser', 'trusted-header'].includes(me.value.authMode || '')) {
    api.get('/api/admin/users').then((out) => admin.markWaiting(out.users), () => {});
  }
});
onBeforeUnmount(stopPoll);
</script>

<template>
  <section id="admin" :class="{ open: isOpen }" aria-label="People and roles">
    <div class="automation-head">
      <h2>People &amp; roles</h2>
      <div class="adm-tabs" role="tablist" aria-label="Admin sections">
        <button type="button" role="tab" :aria-selected="tab === 'people' && !view" :class="{ active: tab === 'people' && !view }"
                @click="tab = 'people'; view = null; stopPoll()">
          People <span v-if="admin.waiting" class="adm-badge" :title="`${plural(admin.waiting, 'person', 'people')} waiting for approval`">{{ admin.waiting }}</span>
        </button>
        <button type="button" role="tab" :aria-selected="tab === 'roles' && !view" :class="{ active: tab === 'roles' && !view }"
                @click="tab = 'roles'; view = null; stopPoll()">Roles</button>
      </div>
    </div>
    <div class="statistics-content">
      <section v-if="view" class="statistics-block">
        <div class="sec-h"><button type="button" @click="back">← back</button> <span>{{ viewTitle }}</span><span class="usage">{{ viewMeta }}</span></div>
        <div class="usage admin-note">Read-only admin view. Every view is recorded in the audit log.</div>
        <template v-if="view.kind === 'chats' && view.data">
          <button v-for="c in view.data.chats" :key="c.id" type="button" class="admin-chat" @click="openChat(view.user, c.id)">
            <span>{{ c.title || c.id }}</span><span v-if="c.running" class="admin-live">● live</span>
            <span class="usage">{{ new Date(c.updated_at).toLocaleString() }}</span>
          </button>
          <div v-if="!view.data.chats.length" class="empty">no chats</div>
        </template>
        <template v-else-if="view.kind === 'chat' && view.data">
          <template v-for="doc in view.data.documents || []" :key="doc.id">
            <button type="button" class="link usage" @click="openDocument(doc.id)">📎 {{ doc.filename }}</button><br>
          </template>
          <div v-for="(m, i) in view.data.messages.filter((x: any) => x.role !== 'system')" :key="i" class="admin-msg">
            <div class="admin-msg-role">{{ m.role === 'tool' ? 'tool result' : m.role }}{{ m.compacted ? ' (compacted)' : '' }}</div>
            <details v-if="m.role === 'tool'">
              <summary>{{ String(m.content || '').length.toLocaleString() }} chars</summary>
              <pre>{{ m.content || '' }}</pre>
            </details>
            <template v-else>
              <div v-if="m.content" class="admin-msg-body"><Markdown :text="m.content" /></div>
              <div v-if="m.images?.length" class="usage">{{ m.images.length }} image(s) attached</div>
              <details v-for="(call, j) in m.tool_calls || []" :key="j">
                <summary>calls {{ call.function?.name }}</summary>
                <pre>{{ call.function?.arguments || '' }}</pre>
              </details>
            </template>
          </div>
        </template>
        <template v-else-if="view.kind === 'connectors' && view.data">
          <div v-for="s in view.data.servers" :key="s.name" class="admin-connector">
            <strong>{{ s.title }}</strong>
            <div v-if="s.reason" class="usage">{{ s.reason }}</div>
            <template v-else>
              <!-- Nothing is read until a view is picked: each read is an audited look. -->
              <div class="int-tabs" role="tablist">
                <button v-for="v in s.views" :key="v.id" type="button" role="tab" :aria-selected="connectorTab[s.name] === v.id"
                        :class="{ active: connectorTab[s.name] === v.id }" @click="connectorTab[s.name] = v.id">{{ v.title }}</button>
              </div>
              <template v-for="v in s.views" :key="v.id">
                <IntegrationView v-if="connectorTab[s.name] === v.id" :view="v"
                                 :base="`/api/admin/users/${enc(view.user.id)}/integrations/${enc(s.name)}/views/${enc(v.id)}`" />
              </template>
            </template>
          </div>
          <div v-if="!view.data.servers.length" class="empty">no connectors</div>
        </template>
      </section>

      <div v-else-if="tab === 'people'" role="tabpanel">
        <div class="adm-wrap">
          <div class="adm-toolbar">
            <input v-model="search" type="search" placeholder="Find people by name or email" aria-label="Find people" autocomplete="off">
            <button v-if="me.authMode === 'multiuser'" type="button" class="primary" :aria-expanded="inviteOpen" @click="toggleInvite">Invite</button>
          </div>
          <form v-if="inviteOpen" class="adm-invite" @submit.prevent="createInvite">
            <label for="inviteEmail">Invite someone <span class="adm-meta">email optional: leave it empty for a link anyone can use once</span></label>
            <div class="adm-invite-row">
              <input id="inviteEmail" v-model="inviteEmail" type="email" autocomplete="off" placeholder="person@example.com">
              <button class="primary" type="submit">Create link</button>
            </div>
            <div v-if="inviteUrl || inviteResult" class="usage invite-result" role="status">
              <template v-if="inviteUrl">Share this link once: <a :href="inviteUrl">{{ inviteUrl }}</a>
                <button type="button" class="adm-small" @click="copyInvite">{{ copied ? 'Copied' : 'Copy' }}</button></template>
              <template v-else>{{ inviteResult }}</template>
            </div>
            <div class="adm-invites">
              <div v-if="invites.length" class="adm-sub">Open invitations</div>
              <div v-for="inv in invites" :key="inv.id" class="adm-invite-item">
                <div class="adm-who"><strong>{{ inv.email || 'Anyone with the link' }}</strong><span class="adm-meta">expires {{ when(inv.expiresAt) }}</span></div>
                <button type="button" class="adm-small" @click="revoke(inv.id)">Revoke</button>
              </div>
            </div>
          </form>
          <label v-if="me.authMode === 'multiuser' && policy" class="adm-requests"
                 :title="policy.locked ? 'The access settings are set in code or frozen: change the files instead.' : undefined">
            <input type="checkbox" :checked="Boolean(policy.allowRequests)" :disabled="Boolean(policy.locked)"
                   @change="setRequests(($event.target as HTMLInputElement).checked)">
            <span>Let people request access from the sign-in page <span class="adm-meta">Requests wait under Waiting until you approve them. Their email addresses are not checked.</span></span>
          </label>
          <div class="adm-filters" role="group" aria-label="Show">
            <button v-for="c in chips" :key="c.key" type="button" class="adm-filter"
                    :class="{ active: filter === c.key, waiting: c.key === 'pending' && c.n }" :aria-pressed="filter === c.key" @click="filter = c.key">
              <span>{{ c.label }}</span><span class="adm-count">{{ c.n }}</span>
            </button>
          </div>
          <div v-if="msg" class="usage" role="alert">{{ msg }}</div>
          <div class="adm-groups">
            <section v-for="g in shownGroups" :key="g.key" class="adm-group" :class="{ waiting: g.key === 'pending' }">
              <div class="adm-group-h"><h3>{{ g.title }}</h3><span class="adm-count">{{ g.people.length }}</span></div>
              <p v-if="g.note" class="adm-note">{{ g.note }}</p>
              <PersonRow v-for="u in g.people" :key="u.id" :user="u" :roles="roleNames"
                         @changed="changed(u, $event)" @chats="openChats(u)" @connectors="openConnectors(u)" />
              <div v-if="!g.people.length" class="empty">{{ search ? 'Nobody here matches.' : g.key === 'pending' ? 'Nobody is waiting.' : 'Nobody here yet.' }}</div>
            </section>
            <div v-if="!shownGroups.length" class="empty">{{ search ? 'Nobody matches.' : 'No one has signed in yet.' }}</div>
          </div>
          <div class="adm-foot" title="Config fingerprint: compare with `tinywebui fingerprint` on the checked-in files">{{ foot }}</div>
        </div>
      </div>

      <div v-else role="tabpanel">
        <div class="adm-wrap">
          <p class="adm-lede">A role decides what everyone holding it can use. People get exactly what their role allows; change the role to change what they can do. <b>Admin</b> and <b>User</b> always exist.</p>
          <div v-if="rolesMsg || policy?.locked" class="usage" role="alert">
            {{ rolesMsg || 'Roles are set in tinywebui.config.js or the config is frozen: change them in the files.' }}
          </div>
          <div v-if="policy" class="adm-roles">
            <article v-for="r in policy.roles" :key="r.name" class="adm-role-card" :class="{ open: openRole === r.name }">
              <div class="adm-role-h">
                <div class="adm-role-title"><h3>{{ roleLabel(r.name) }}</h3><span class="chip">{{ r.builtin ? 'built in' : 'custom' }}</span></div>
                <button type="button" class="adm-link" :disabled="!r.users" @click="showPeopleOf(r)">{{ plural(r.users, 'person', 'people') }}</button>
                <button v-if="openRole !== r.name" type="button" class="adm-small" :disabled="policy.locked" @click="openRole = r.name">{{ r.fixed ? 'Settings' : 'Edit' }}</button>
              </div>
              <RoleEditor v-if="openRole === r.name" :role="r" :policy="policy" @saved="roleSaved" @deleted="roleDeleted" @cancel="openRole = null" />
              <template v-else>
                <p class="adm-role-sum">{{ roleSummary(r) }}</p>
                <p v-if="!r.fixed && policy.models.length" class="adm-meta">{{ r.models === '*' ? 'Any model' : r.models.length ? `Models: ${r.models.join(', ')}` : 'No models' }}</p>
                <p v-if="roleSettingsSummary(r.settings)" class="adm-meta">Chats: {{ roleSettingsSummary(r.settings) }}</p>
              </template>
            </article>
          </div>
          <form v-if="policy && !policy.locked" class="adm-role-new" @submit.prevent="createRole">
            <label for="roleNewName">New role</label>
            <div class="adm-invite-row">
              <input id="roleNewName" v-model="newRole" type="text" autocomplete="off" placeholder="e.g. reviewer" pattern="[a-z][a-z0-9\-]{0,31}" maxlength="32" required>
              <select v-model="newRoleFrom" aria-label="Start from">
                <option v-for="r in policy.roles.filter((x: any) => !x.fixed)" :key="r.name" :value="r.name">Copy of {{ roleLabel(r.name) }}</option>
                <option value="">Start empty</option>
              </select>
              <button class="primary" type="submit">Create role</button>
            </div>
            <small class="adm-meta">Lowercase letters, digits and dashes. It starts as a copy of the role you pick.</small>
          </form>
        </div>
      </div>
    </div>
  </section>
</template>
