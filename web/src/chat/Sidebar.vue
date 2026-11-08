<script setup lang="ts">
/**
 * The chat-history sidebar: navigation, the chronological list grouped by
 * folder and day, the full-text search that swaps in over it, a draggable
 * width, and on a phone the drawer it lives in.
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { FEATURE } from '../../../shared/features.ts';
import { markSnippet } from '../core/md.ts';
import { useSession } from '../stores/session.ts';
import { useChats, type ChatRow } from '../stores/chats.ts';
import { useChat } from '../stores/chat.ts';
import { usePanels, PANEL, type PanelName } from '../stores/panels.ts';
import { useUi } from '../stores/ui.ts';
import { useAdmin } from '../stores/admin.ts';
import Icon from '../ui/Icon.vue';
import ChatItem from './ChatItem.vue';
import OrganizeDialog from './OrganizeDialog.vue';
import NewFolderDialog from './NewFolderDialog.vue';

const session = useSession();
const chats = useChats();
const chat = useChat();
const panels = usePanels();
const ui = useUi();
const admin = useAdmin();

const sideEl = ref<HTMLElement>();
const newEl = ref<HTMLButtonElement>();
const searchEl = ref<HTMLInputElement>();
const organizing = ref<ChatRow | null>(null);
const folderDialog = ref(false);

// Picking a chat or New is a way out of any open panel, unless it holds
// unsaved edits the person chose to keep.
const openChat = (id: string) => { if (panels.closeAll()) chat.openChat(id); };
const newChat = () => { if (panels.closeAll()) chat.newChat(); };

const NAV: { panel: PanelName, label: string, icon: string, feature: string | null }[] = [
  { panel: PANEL.AUTOMATIONS, label: 'Automations', icon: 'automations', feature: FEATURE.AUTOMATIONS },
  { panel: PANEL.INTEGRATIONS, label: 'Integrations', icon: 'integrations', feature: FEATURE.INTEGRATIONS },
  { panel: PANEL.MCP, label: 'MCP servers', icon: 'mcp', feature: FEATURE.MCP },
  { panel: PANEL.SETTINGS, label: 'Settings', icon: 'settings', feature: null },
  { panel: PANEL.STATISTICS, label: 'Statistics', icon: 'statistics', feature: FEATURE.STATISTICS },
  { panel: PANEL.ADMIN, label: 'Admin', icon: 'admin', feature: FEATURE.ADMIN }
];
const nav = computed(() => NAV.filter((n) => (n.feature ? session.can(n.feature as never) : session.settingsVisible)));

/* ---------- the list ---------- */

/** Recent chats get familiar rolling buckets; older chats use calendar months. */
function bucketOf(updatedAt: number, now: number) {
  const startOfDay = (ms: number) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const days = Math.round((startOfDay(now) - startOfDay(updatedAt)) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days <= 7) return 'Previous 7 days';
  if (days <= 30) return 'Previous 30 days';
  const d = new Date(updatedAt);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString('en-US', sameYear ? { month: 'long' } : { month: 'long', year: 'numeric' });
}

type Row = { kind: 'heading', key: string, label: string } | { kind: 'chat', key: string, chat: ChatRow } | { kind: 'draft', key: string };
type Group = { folder: string | null, rows: Row[], count: number };

// The draft in progress is not a chat on the server yet: it gets a row only so
// the list shows where you are, in the unfiled Today bucket, and disappears
// the moment it becomes a real chat or is abandoned.
const isDraft = computed(() => !chat.chatId && !chat.loading);

const groups = computed<Group[]>(() => {
  const byFolder = new Map<string | null, (ChatRow | null)[]>();
  // A folder just created and not yet moved into is still a real folder.
  for (const name of chats.folders) byFolder.set(name, []);
  for (const c of chats.chats) {
    const folder = (c.folder || '').trim() || null;
    if (!byFolder.has(folder)) byFolder.set(folder, []);
    byFolder.get(folder)!.push(c); // set on the line above
  }
  if (isDraft.value) {
    if (!byFolder.has(null)) byFolder.set(null, []);
    byFolder.get(null)!.unshift(null); // set on the line above
  }
  const names = [...byFolder.keys()].sort((a, b) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b)));
  const now = Date.now();
  return names.map((folder) => {
    const list = byFolder.get(folder) || [];
    const rows: Row[] = [];
    let last = '';
    for (const c of list) {
      const bucket = c ? bucketOf(c.updated_at, now) : 'Today';
      if (bucket !== last) { last = bucket; rows.push({ kind: 'heading', key: `h:${folder}:${bucket}`, label: bucket }); }
      rows.push(c ? { kind: 'chat', key: c.id, chat: c } : { kind: 'draft', key: 'draft' });
    }
    return { folder, rows, count: list.length };
  });
});

const empty = computed(() => !chats.chats.length && !isDraft.value && !chats.folders.length);
const currentId = computed(() => chat.loading || chat.chatId);

function toggleFolder(folder: string, e: Event) {
  const open = (e.target as HTMLDetailsElement).open;
  if (open) chats.expanded.add(folder); else chats.expanded.delete(folder);
}

/* ---------- search ---------- */

const SEARCH_ROLE_LABEL: Record<string, string> = { user: 'you', assistant: 'assistant', tool: 'tool' };
const searching = computed(() => Boolean(chats.query.trim()) && chats.results !== null);
const q = computed({ get: () => chats.query, set: (v: string) => chats.search(v) });
function onSearchKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && chats.query) { e.preventDefault(); chats.clearSearch(); }
}
function clearSearch() { chats.clearSearch(); searchEl.value?.focus(); }

/* ---------- width ---------- */

/**
 * A draggable sidebar, remembered per browser. The width lives in a CSS
 * variable so the stylesheet keeps the default: clearing it resets.
 */
const SIDE_KEY = 'tinywebui.sideWidth';
const SIDE_MIN = 176;
const SIDE_MAX = 560;
function setSideWidth(px: number) {
  const clamped = Math.round(Math.min(SIDE_MAX, Math.max(SIDE_MIN, px)));
  document.documentElement.style.setProperty('--side-w', `${clamped}px`);
  try { localStorage.setItem(SIDE_KEY, String(clamped)); } catch { /* not important enough to fail over */ }
}
function resetSideWidth() {
  document.documentElement.style.removeProperty('--side-w');
  try { localStorage.removeItem(SIDE_KEY); } catch { /* as above */ }
}
function startResize(e: PointerEvent) {
  const grip = e.currentTarget as HTMLElement;
  // Pointer capture keeps the drag alive over the transcript or off the window edge.
  grip.setPointerCapture(e.pointerId);
  document.body.classList.add('resizing');
  const startX = e.clientX;
  const startW = sideEl.value?.getBoundingClientRect().width || 240;
  const move = (ev: PointerEvent) => setSideWidth(startW + (ev.clientX - startX));
  const done = () => {
    grip.removeEventListener('pointermove', move);
    grip.removeEventListener('pointerup', done);
    grip.removeEventListener('pointercancel', done);
    document.body.classList.remove('resizing');
  };
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', done);
  grip.addEventListener('pointercancel', done);
  e.preventDefault();
}
// A drag is not reachable without a pointer, so the separator works from the keyboard too.
function resizeKey(e: KeyboardEvent) {
  const w = sideEl.value?.getBoundingClientRect().width || 240;
  const step = e.shiftKey ? 48 : 16;
  if (e.key === 'ArrowLeft') setSideWidth(w - step);
  else if (e.key === 'ArrowRight') setSideWidth(w + step);
  else if (e.key === 'Home' || e.key === 'Escape') resetSideWidth();
  else return;
  e.preventDefault();
}

onMounted(() => {
  try {
    const saved = Number(localStorage.getItem(SIDE_KEY));
    if (Number.isFinite(saved) && saved > 0) setSideWidth(saved);
  } catch { /* the stylesheet decides */ }
});

// The drawer traps Tab while open; focus goes in with it and comes back out.
watch(() => ui.drawerOpen, (open) => {
  if (open) nextTick(() => newEl.value?.focus());
  else if (sideEl.value?.contains(document.activeElement)) document.getElementById('menu')?.focus();
});

function rowKey(e: KeyboardEvent, go: () => void) {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault(); // space would scroll the list instead
  go();
}
</script>

<template>
  <aside id="side" ref="sideEl" aria-label="Chat history" :class="{ open: ui.narrow && ui.drawerOpen }"
         :inert="ui.narrow && !ui.drawerOpen" :aria-hidden="ui.narrow && !ui.drawerOpen ? 'true' : undefined">
    <div class="brand">
      <button class="brand-home" type="button" title="New chat" aria-label="TinyWebUI, start a new chat" @click="newChat">
        <img class="logo" src="/favicon.svg" alt="" aria-hidden="true">
        <span class="brand-name">TinyWebUI</span>
      </button>
    </div>
    <div class="side-scroll">
      <nav class="nav">
        <button id="new" ref="newEl" class="nav-item" type="button" @click="newChat"><Icon name="new" /><span>New chat</span></button>
        <div v-if="session.can(FEATURE.SEARCH)" class="search-row nav-item">
          <Icon name="search" />
          <input id="chatSearch" ref="searchEl" v-model="q" type="search" placeholder="Search" aria-label="Search chats"
                 autocomplete="off" spellcheck="false" @keydown="onSearchKey">
          <button v-if="chats.query" id="chatSearchClear" class="x" type="button" aria-label="Clear search" @click="clearSearch">×</button>
        </div>
        <button v-for="n in nav" :id="`toggle-${n.panel}`" :key="n.panel" class="nav-item" type="button"
                :class="{ active: panels.open === n.panel }" @click="panels.toggle(n.panel)">
          <Icon :name="n.icon" /><span>{{ n.label }}</span>
          <span v-if="n.panel === PANEL.ADMIN && admin.waiting" class="adm-badge"
                :title="`${admin.waiting} waiting for approval`">{{ admin.waiting }}</span>
        </button>
        <button v-if="session.canLogout" id="logout" class="nav-item" type="button" @click="session.logout()">
          <Icon name="logout" /><span>Log out</span>
        </button>
      </nav>
      <div class="side-label">
        <span>{{ searching ? 'Search results' : 'Recent conversations' }}</span>
        <button v-if="session.can(FEATURE.FOLDERS)" id="newFolder" class="icon-btn" type="button" aria-label="New folder" title="New folder"
                @click="folderDialog = true"><Icon name="folderPlus" /></button>
      </div>

      <div id="chats">
        <template v-if="searching">
          <div v-if="!chats.results?.length" class="empty">no matches for “{{ chats.query }}”</div>
          <div v-for="(r, i) in chats.results" :key="`${r.chatId}:${i}`" class="chat-item search-hit" tabindex="0" role="button"
               @click="openChat(r.chatId)" @keydown="rowKey($event, () => openChat(r.chatId))">
            <div class="t">
              <div class="hit-title">{{ r.chatTitle }}<span class="hit-role">{{ SEARCH_ROLE_LABEL[r.role] || r.role }}</span></div>
              <!-- markSnippet escapes everything but its own <mark>. -->
              <div class="hit-snippet" v-html="markSnippet(r.snippet)" />
            </div>
          </div>
        </template>
        <template v-else>
          <div v-if="empty" class="empty">no saved chats</div>
          <template v-for="g in groups" :key="g.folder ?? ''">
            <details v-if="g.folder !== null" class="chat-folder" :open="chats.expanded.has(g.folder)" @toggle="toggleFolder(g.folder, $event)">
              <summary class="chat-folder-heading">
                <span class="chat-folder-name">{{ g.folder }}</span><span class="chat-folder-count">{{ g.count }}</span>
              </summary>
              <div class="chat-folder-content">
                <template v-for="row in g.rows" :key="row.key">
                  <div v-if="row.kind === 'heading'" class="chat-date-heading">{{ row.label }}</div>
                  <ChatItem v-else-if="row.kind === 'chat'" :chat="row.chat" :active="row.chat.id === currentId"
                            @open="openChat(row.chat.id)" @organize="organizing = row.chat" />
                </template>
              </div>
            </details>
            <template v-else>
              <template v-for="row in g.rows" :key="row.key">
                <div v-if="row.kind === 'heading'" class="chat-date-heading">{{ row.label }}</div>
                <div v-else-if="row.kind === 'draft'" class="chat-item active draft" tabindex="0" role="button" aria-current="true">
                  <span class="t">{{ chat.model.chat.title || 'New chat' }}</span>
                </div>
                <ChatItem v-else :chat="row.chat" :active="row.chat.id === currentId"
                          @open="openChat(row.chat.id)" @organize="organizing = row.chat" />
              </template>
            </template>
          </template>
        </template>
      </div>
    </div>
    <div id="side-resize" role="separator" aria-orientation="vertical" tabindex="0" aria-label="Resize chat history"
         title="Drag to resize, double-click to reset" @pointerdown="startResize" @dblclick="resetSideWidth" @keydown="resizeKey" />
    <OrganizeDialog v-if="organizing" :chat="organizing" @close="organizing = null" />
    <NewFolderDialog v-if="folderDialog" @close="folderDialog = false" />
  </aside>
</template>
