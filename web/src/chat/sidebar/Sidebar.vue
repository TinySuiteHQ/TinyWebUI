<script setup lang="ts">
/**
 * The chat-history sidebar: new chat, search and files, the chronological
 * list grouped by folder and day, the full-text search that swaps in over it,
 * the account button (settings, log out) pinned at the bottom, a draggable
 * width, and on a phone the drawer it lives in. Everything that configures
 * the app lives in the settings dialog, so the sidebar stays about chats.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { FEATURE } from '../../../../shared/features.ts';
import { markSnippet } from '../../core/md.ts';
import { useSession } from '../../stores/session.ts';
import { useChats, type ChatRow, type SearchHit } from '../../stores/chats.ts';
import { useChat } from '../../stores/chat.ts';
import { usePanels, PANEL } from '../../stores/panels.ts';
import { useUi } from '../../stores/ui.ts';
import { useAdmin } from '../../stores/admin.ts';
import Icon from '../../ui/Icon.vue';
import ChatItem from './ChatItem.vue';
import FolderDialog from './FolderDialog.vue';

const session = useSession();
const chats = useChats();
const chat = useChat();
const panels = usePanels();
const ui = useUi();
const admin = useAdmin();

const sideEl = ref<HTMLElement>();
const newEl = ref<HTMLButtonElement>();
const searchEl = ref<HTMLInputElement>();
/** The open folder dialog, if any: `folder` null for a new one, else the folder whose settings it shows. */
const folderDialog = ref<{ folder: string | null } | undefined>();

// Picking a chat or New is a way out of any open panel, unless it holds
// unsaved edits the person chose to keep.
const openChat = (id: string) => { if (panels.closeAll()) chat.openChat(id); };
const newChat = () => { if (panels.closeAll()) chat.newChat(); };

const showFiles = computed(() => session.can(FEATURE.ATTACHMENTS) || session.can(FEATURE.IMAGES));
const showMcp = computed(() => session.can(FEATURE.MCP) || session.can(FEATURE.INTEGRATIONS));

/* ---------- account ---------- */

const accountEl = ref<HTMLElement>();
const accountBtn = ref<HTMLButtonElement>();
const accountOpen = ref(false);
const user = computed(() => session.me.user);
const accountName = computed(() => user.value?.name || user.value?.email || 'Settings');
const initial = computed(() => (user.value?.name || user.value?.email || '?').trim().charAt(0).toUpperCase());
const hasSettings = computed(() => panels.sections.length > 0);
// With nothing but settings behind it, the button opens them straight away.
const hasMenu = computed(() => session.canLogout);
const showAccount = computed(() => hasSettings.value || hasMenu.value);

function onAccount() {
  if (hasMenu.value) accountOpen.value = !accountOpen.value;
  else panels.openSettings();
}
function openSettings() { accountOpen.value = false; panels.openSettings(); }
function closeAccount(refocus = false) {
  accountOpen.value = false;
  if (refocus) accountBtn.value?.focus();
}
function onDocPointer(e: PointerEvent) {
  if (accountOpen.value && !accountEl.value?.contains(e.target as Node)) closeAccount();
}
function onDocKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && accountOpen.value) { e.preventDefault(); closeAccount(true); }
}

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

type Row = { kind: 'heading', key: string, label: string } | { kind: 'chat', key: string, chat: ChatRow, depth: number } | { kind: 'draft', key: string };
type Group = { folder: string | null, rows: Row[], count: number };

// The draft in progress is not a chat on the server yet: it gets a row only so
// the list shows where you are, in the unfiled Today bucket, and disappears
// the moment it becomes a real chat or is abandoned.
const isDraft = computed(() => !chat.chatId && !chat.loading);

/**
 * Forks are listed under the chat they were branched from, wherever that one
 * is, and a fork of a fork under its own parent. One whose original is gone
 * (or not in the list) stands on its own. A family is placed by its latest
 * activity, so a fresh fork does not hide under an old original.
 */
const family = computed(() => {
  const listed = new Set(chats.chats.map((c) => c.id));
  const forks = new Map<string, ChatRow[]>();
  for (const c of chats.chats) {
    if (!c.parent_id || c.parent_id === c.id || !listed.has(c.parent_id)) continue;
    if (!forks.has(c.parent_id)) forks.set(c.parent_id, []);
    forks.get(c.parent_id)!.push(c); // set on the line above
  }
  const latest = new Map<string, number>();
  const visit = (c: ChatRow, seen: Set<string>): number => {
    if (latest.has(c.id)) return latest.get(c.id)!;
    if (seen.has(c.id)) return c.updated_at; // a cycle in hand-edited data: stop
    seen.add(c.id);
    const t = Math.max(c.updated_at, ...(forks.get(c.id) || []).map((f) => visit(f, seen)));
    latest.set(c.id, t);
    return t;
  };
  for (const c of chats.chats) visit(c, new Set());
  const roots = chats.chats.filter((c) => !c.parent_id || c.parent_id === c.id || !listed.has(c.parent_id))
    .sort((a, b) => latest.get(b.id)! - latest.get(a.id)!);
  return { forks, latest, roots };
});

/** A chat's row, then its forks' rows (newest first) one level in. */
function withForks(c: ChatRow, depth: number, out: Row[], seen: Set<string>) {
  if (seen.has(c.id)) return;
  seen.add(c.id);
  out.push({ kind: 'chat', key: c.id, chat: c, depth });
  const kids = [...(family.value.forks.get(c.id) || [])].sort((a, b) => family.value.latest.get(b.id)! - family.value.latest.get(a.id)!);
  for (const k of kids) withForks(k, depth + 1, out, seen);
}

const groups = computed<Group[]>(() => {
  const byFolder = new Map<string | null, (ChatRow | null)[]>();
  // A folder just created and not yet moved into is still a real folder.
  for (const name of chats.folders) byFolder.set(name, []);
  for (const c of family.value.roots) {
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
    let count = 0;
    const seen = new Set<string>();
    for (const c of list) {
      const bucket = c ? bucketOf(family.value.latest.get(c.id) ?? c.updated_at, now) : 'Today';
      if (bucket !== last) { last = bucket; rows.push({ kind: 'heading', key: `h:${folder}:${bucket}`, label: bucket }); }
      const before = rows.length;
      if (c) withForks(c, 0, rows, seen); else rows.push({ kind: 'draft', key: 'draft' });
      count += rows.length - before;
    }
    return { folder, rows, count };
  });
});

const empty = computed(() => !chats.chats.length && !isDraft.value && !chats.folders.length);
const currentId = computed(() => chat.loading || chat.chatId);

function toggleFolder(folder: string, e: Event) {
  const open = (e.target as HTMLDetailsElement).open;
  if (open) chats.expanded.add(folder); else chats.expanded.delete(folder);
}

/* ---------- search ---------- */

const SEARCH_ROLE_LABEL: Record<string, string> = { user: 'You', assistant: 'Assistant', tool: 'Tool result' };
// A short chat's title is its first message, so the hit in that message would
// repeat the title as a second line, reading as the same chat twice. Then the
// title alone shows, with the match marked in it.
const plainText = (s: string) => s.replace(/[‹›…]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const repeatsTitle = (r: SearchHit) => {
  const snippet = plainText(r.snippet);
  return !snippet || plainText(r.chatTitle).includes(snippet);
};
// The snippet carries the marks; it can stand in for a title it spells out whole.
const titleIsSnippet = (r: SearchHit) => plainText(r.chatTitle) === plainText(r.snippet) && !r.snippet.includes('…');
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
  document.addEventListener('pointerdown', onDocPointer);
  document.addEventListener('keydown', onDocKey);
  try {
    const saved = Number(localStorage.getItem(SIDE_KEY));
    if (Number.isFinite(saved) && saved > 0) setSideWidth(saved);
  } catch { /* the stylesheet decides */ }
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointer);
  document.removeEventListener('keydown', onDocKey);
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
        <button v-if="showFiles" id="toggle-files" class="nav-item" type="button"
                :class="{ active: panels.open === PANEL.FILES }" @click="panels.toggle(PANEL.FILES)">
          <Icon name="files" /><span>Files</span>
        </button>
        <button v-if="showMcp" id="toggle-mcp" class="nav-item" type="button"
                :class="{ active: panels.open === PANEL.MCP }" @click="panels.toggle(PANEL.MCP)">
          <Icon name="mcp" /><span>MCP</span>
        </button>
      </nav>
      <div class="side-label">
        <span>{{ searching ? 'Search results' : 'Recent conversations' }}</span>
        <button v-if="session.can(FEATURE.FOLDERS)" id="newFolder" class="icon-btn" type="button" aria-label="New folder" title="New folder"
                @click="folderDialog = { folder: null }"><Icon name="folderPlus" /></button>
      </div>

      <div id="chats">
        <template v-if="searching">
          <div v-if="!chats.results?.length" class="empty">no matches for “{{ chats.query }}”</div>
          <div v-for="(r, i) in chats.results" :key="`${r.chatId}:${i}`" class="chat-item search-hit" tabindex="0" role="button"
               @click="openChat(r.chatId)" @keydown="rowKey($event, () => openChat(r.chatId))">
            <div class="t">
              <div class="hit-title">
                <!-- markSnippet escapes everything but its own <mark>. -->
                <span v-if="titleIsSnippet(r)" class="hit-name" v-html="markSnippet(r.snippet.trim())" />
                <span v-else class="hit-name">{{ r.chatTitle }}</span>
                <span v-if="r.matches > 1" class="hit-count" :title="`${r.matches} messages in this chat match`">{{ r.matches }} matches</span>
              </div>
              <div v-if="!repeatsTitle(r)" class="hit-snippet">
                <span class="hit-who">{{ SEARCH_ROLE_LABEL[r.role] || r.role }}:</span> <span v-html="markSnippet(r.snippet)" />
              </div>
            </div>
          </div>
        </template>
        <template v-else>
          <div v-if="empty" class="empty">no saved chats</div>
          <template v-for="g in groups" :key="g.folder ?? ''">
            <details v-if="g.folder !== null" class="chat-folder" :open="chats.expanded.has(g.folder)" @toggle="toggleFolder(g.folder, $event)">
              <summary class="chat-folder-heading">
                <span class="chat-folder-name">{{ g.folder }}</span>
                <span v-if="chats.prompts[g.folder]" class="folder-mark" title="Has its own instructions"><Icon name="instructions" size=".8rem" /></span>
                <span class="chat-folder-count">{{ g.count }}</span>
                <button v-if="session.can(FEATURE.FOLDERS)" class="organize-chat folder-options" type="button" title="Folder settings: name, chats and instructions"
                        :aria-label="`Settings for folder “${g.folder}”`" @click.prevent.stop="folderDialog = { folder: g.folder }"
                        @keydown.stop><Icon name="more" /></button>
              </summary>
              <div class="chat-folder-content">
                <template v-for="row in g.rows" :key="row.key">
                  <div v-if="row.kind === 'heading'" class="chat-date-heading">{{ row.label }}</div>
                  <ChatItem v-else-if="row.kind === 'chat'" :chat="row.chat" :depth="row.depth" :active="row.chat.id === currentId"
                            @open="openChat(row.chat.id)" />
                </template>
              </div>
            </details>
            <template v-else>
              <template v-for="row in g.rows" :key="row.key">
                <div v-if="row.kind === 'heading'" class="chat-date-heading">{{ row.label }}</div>
                <div v-else-if="row.kind === 'draft'" class="chat-item active draft" tabindex="0" role="button" aria-current="true">
                  <span class="t">{{ chat.model.chat.title || 'New chat' }}</span>
                </div>
                <ChatItem v-else :chat="row.chat" :depth="row.depth" :active="row.chat.id === currentId"
                          @open="openChat(row.chat.id)" />
              </template>
            </template>
          </template>
        </template>
      </div>
    </div>
    <div v-if="showAccount" ref="accountEl" class="side-foot">
      <div v-if="accountOpen" class="popover account-menu" role="menu" aria-label="Account">
        <div v-if="user" class="account-who">
          <span class="account-who-name">{{ user.name || user.email }}</span>
          <span v-if="user.name && user.email" class="account-who-sub">{{ user.email }}</span>
        </div>
        <button v-if="hasSettings" id="openSettings" type="button" class="pop-item" role="menuitem" @click="openSettings">
          <Icon name="settings" /><span class="pop-name">Settings</span>
          <span v-if="admin.waiting" class="adm-badge" :title="`${admin.waiting} waiting for approval`">{{ admin.waiting }}</span>
        </button>
        <hr v-if="hasSettings" class="pop-sep">
        <button id="logout" type="button" class="pop-item" role="menuitem" @click="session.logout()">
          <Icon name="logout" /><span class="pop-name">Log out</span>
        </button>
      </div>
      <button id="account" ref="accountBtn" class="nav-item account-btn" type="button"
              :class="{ active: accountOpen || (!hasMenu && panels.sections.some((s) => s.panel === panels.open)) }"
              :aria-haspopup="hasMenu ? 'menu' : undefined" :aria-expanded="hasMenu ? accountOpen : undefined"
              :aria-label="hasMenu ? `Account: ${accountName}` : 'Settings'" @click="onAccount">
        <span v-if="user" class="account-avatar" aria-hidden="true">{{ initial }}</span>
        <Icon v-else name="settings" />
        <span class="account-name">{{ accountName }}</span>
        <span v-if="admin.waiting" class="adm-badge" :title="`${admin.waiting} waiting for approval`">{{ admin.waiting }}</span>
      </button>
    </div>
    <div id="side-resize" role="separator" aria-orientation="vertical" tabindex="0" aria-label="Resize chat history"
         title="Drag to resize, double-click to reset" @pointerdown="startResize" @dblclick="resetSideWidth" @keydown="resizeKey" />
    <FolderDialog v-if="folderDialog" :folder="folderDialog.folder" @close="folderDialog = undefined" />
  </aside>
</template>
