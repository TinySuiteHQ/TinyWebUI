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
import Popover from '../../ui/Popover.vue';
import ChatItem from './ChatItem.vue';
import FolderDialog, { type FolderDialogMode } from './FolderDialog.vue';

const session = useSession();
const chats = useChats();
const chat = useChat();
const panels = usePanels();
const ui = useUi();
const admin = useAdmin();

const sideEl = ref<HTMLElement>();
const newEl = ref<HTMLButtonElement>();
const searchEl = ref<HTMLInputElement>();
/** The open folder dialog, if any: `folder` null for a new one. */
const folderDialog = ref<{ folder: string | null, mode: FolderDialogMode } | undefined>();
/** The folder whose menu is open. */
const folderMenu = ref<string | null>(null);

// Picking a chat or New is a way out of any open panel, unless it holds
// unsaved edits the person chose to keep.
const openChat = (id: string) => { if (panels.closeAll()) chat.openChat(id); };
const newChat = () => { if (panels.closeAll()) chat.newChat(); };
/** A folder is a place to work in, not only to file into: a chat can start there. */
function newChatIn(folder: string) {
  folderMenu.value = null;
  if (!panels.closeAll()) return;
  chats.expanded.add(folder);
  chat.newChat({ folder });
}
function openFolderDialog(folder: string | null, mode: FolderDialogMode) {
  folderMenu.value = null;
  folderDialog.value = { folder, mode };
}

const showFiles = computed(() => session.can(FEATURE.ATTACHMENTS) || session.can(FEATURE.IMAGES));
const showMcp = computed(() => session.can(FEATURE.MCP) || session.can(FEATURE.INTEGRATIONS));

/* ---------- account ---------- */

const accountEl = ref<HTMLElement>();
const accountBtn = ref<HTMLButtonElement>();
const accountOpen = ref(false);
const accountPop = ref<InstanceType<typeof Popover>>();
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
  // On a phone a menu is a sheet under body, outside the sidebar; the folder check finds it by class either way.
  if (accountOpen.value && !accountEl.value?.contains(e.target as Node) && !accountPop.value?.el?.contains(e.target as Node)) closeAccount();
  if (folderMenu.value && !(e.target as Element).closest?.('.folder-menu, .folder-options')) folderMenu.value = null;
}
function onDocKey(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k' && session.can(FEATURE.SEARCH)) {
    e.preventDefault();
    openSearch();
    return;
  }
  if (e.key === 'Escape' && accountOpen.value) { e.preventDefault(); closeAccount(true); }
  if (e.key === 'Escape' && folderMenu.value) { e.preventDefault(); folderMenu.value = null; }
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

type Row = { kind: 'heading', key: string, label: string } | { kind: 'chat', key: string, chat: ChatRow, depth: number };
type Group = { folder: string | null, rows: Row[], count: number };

// A chat not yet sent is not in the list: a row for it would appear, then
// vanish when it is sent or left, moving everything under it. New chat
// itself is what shows you are there.
const isDraft = computed(() => !chat.chatId && !chat.loading);
// Files and MCP sit over the chat, so while one is open it is where you are, not the chat.
const pageOpen = computed(() => panels.open === PANEL.FILES || panels.open === PANEL.MCP);
const onNewChat = computed(() => isDraft.value && !pageOpen.value);

// Pinned chats leave their folder and day for a section of their own above
// the folders, most recently pinned first; their forks stay where they were.
const pinned = computed(() => chats.chats.filter((c) => c.pinned_at != null)
  .sort((a, b) => (b.pinned_at ?? 0) - (a.pinned_at ?? 0)));
const unpinned = computed(() => chats.chats.filter((c) => c.pinned_at == null));

/**
 * Forks are listed under the chat they were branched from, wherever that one
 * is, and a fork of a fork under its own parent. One whose original is gone
 * (or not in the list) stands on its own. A family is placed by its latest
 * activity, so a fresh fork does not hide under an old original.
 */
const family = computed(() => {
  const listed = new Set(unpinned.value.map((c) => c.id));
  const forks = new Map<string, ChatRow[]>();
  for (const c of unpinned.value) {
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
  for (const c of unpinned.value) visit(c, new Set());
  const roots = unpinned.value.filter((c) => !c.parent_id || c.parent_id === c.id || !listed.has(c.parent_id))
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
  const byFolder = new Map<string | null, ChatRow[]>();
  // A folder just created and not yet moved into is still a real folder.
  for (const name of chats.folders) byFolder.set(name, []);
  for (const c of family.value.roots) {
    const folder = (c.folder || '').trim() || null;
    if (!byFolder.has(folder)) byFolder.set(folder, []);
    byFolder.get(folder)!.push(c); // set on the line above
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
      // A folder is a short list you go back to: by day only outside folders.
      const bucket = folder === null ? bucketOf(family.value.latest.get(c.id) ?? c.updated_at, now) : '';
      if (bucket !== last) { last = bucket; rows.push({ kind: 'heading', key: `h:${bucket}`, label: bucket }); }
      const before = rows.length;
      withForks(c, 0, rows, seen);
      count += rows.length - before;
    }
    return { folder, rows, count };
  });
});

const folderGroups = computed(() => groups.value.filter((g): g is Group & { folder: string } => g.folder !== null));
const looseRows = computed(() => groups.value.find((g) => g.folder === null)?.rows ?? []);
const canFolder = computed(() => session.can(FEATURE.FOLDERS));
const empty = computed(() => !chats.chats.length && !chats.folders.length);
const currentId = computed(() => (pageOpen.value ? null : chat.loading || chat.chatId));

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
// Results show from the first keystroke; until the ones for this query land,
// the last ones stay, dimmed, under "Searching…", rather than passing as current.
const searching = computed(() => Boolean(chats.query.trim()));
const q = computed({ get: () => chats.query, set: (v: string) => chats.search(v) });
/**
 * Search is an icon in the header, not a standing row: the field shows only
 * while it is in use, so the nav stays short. It closes when left empty.
 */
const searchOpen = ref(false);
const showSearch = computed(() => searchOpen.value || Boolean(chats.query));
const searchBtn = ref<HTMLButtonElement>();
function openSearch() {
  // From the keyboard shortcut the sidebar may be away; bring it back first.
  if (ui.narrow ? !ui.drawerOpen : ui.collapsed) ui.toggleMenu();
  searchOpen.value = true;
  nextTick(() => { searchEl.value?.focus(); searchEl.value?.select(); });
}
function closeSearch(refocus = false) {
  chats.clearSearch();
  searchOpen.value = false;
  if (refocus) nextTick(() => searchBtn.value?.focus());
}
function onSearchKey(e: KeyboardEvent) {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  e.stopPropagation();
  if (chats.query) chats.clearSearch(); else closeSearch(true);
}
function onSearchBlur() { if (!chats.query) searchOpen.value = false; }
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

/** Collapsing moves focus to the toggle left in its place, so the keyboard is not stranded. */
function collapse() {
  ui.toggleMenu();
  nextTick(() => document.getElementById('menu')?.focus());
}

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
      <button v-if="session.can(FEATURE.SEARCH)" id="side-search" ref="searchBtn" class="icon-btn" type="button"
              :class="{ active: showSearch }" aria-label="Search chats" title="Search chats (Ctrl+K)" @mousedown.prevent @click="showSearch ? closeSearch() : openSearch()">
        <Icon name="search" />
      </button>
      <!-- On a desktop the toggle lives here while the sidebar is open; collapsed, it waits in the page's corner. -->
      <button v-if="!ui.narrow" id="side-collapse" class="icon-btn" type="button" aria-label="Collapse sidebar" title="Collapse sidebar"
              aria-controls="side" aria-expanded="true" @click="collapse">
        <Icon name="sidebar" />
      </button>
    </div>
    <div class="side-scroll">
      <nav class="nav">
        <div v-if="showSearch" class="search-row nav-item">
          <Icon name="search" />
          <input id="chatSearch" ref="searchEl" v-model="q" type="search" placeholder="Search chats" aria-label="Search chats"
                 autocomplete="off" spellcheck="false" @keydown="onSearchKey" @blur="onSearchBlur">
          <button v-if="chats.query" id="chatSearchClear" class="x" type="button" aria-label="Clear search" @click="clearSearch">×</button>
        </div>
        <button id="new" ref="newEl" class="nav-item" type="button" :class="{ active: onNewChat }"
                :aria-current="onNewChat ? 'page' : undefined" @click="newChat"><Icon name="new" /><span>New chat</span></button>
        <button v-if="showFiles" id="toggle-files" class="nav-item" type="button"
                :class="{ active: panels.open === PANEL.FILES }" @click="panels.toggle(PANEL.FILES)">
          <Icon name="files" /><span>Files</span>
        </button>
        <button v-if="showMcp" id="toggle-mcp" class="nav-item" type="button"
                :class="{ active: panels.open === PANEL.MCP }" @click="panels.toggle(PANEL.MCP)">
          <Icon name="mcp" /><span>MCP</span>
        </button>
      </nav>
      <div id="chats">
        <template v-if="searching">
          <div class="side-label" role="status">
            <span>{{ chats.pending ? 'Searching…' : 'Search results' }}</span>
            <span v-if="chats.pending" class="side-spinner" aria-hidden="true" />
          </div>
          <div v-if="!chats.pending && !chats.results?.length" class="empty">No matches for “{{ chats.query }}”</div>
          <div v-for="(r, i) in chats.results" :key="`${r.chatId}:${i}`" class="chat-item search-hit" :class="{ stale: chats.pending }" tabindex="0" role="button"
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
          <!-- Pinned, then folders (short lists you go back to), then everything else by day, each heading in the one style. -->
          <template v-if="pinned.length">
            <div class="side-label"><span>Pinned</span></div>
            <ChatItem v-for="c in pinned" :key="`pin:${c.id}`" :chat="c" :active="c.id === currentId" @open="openChat(c.id)" />
          </template>
          <template v-if="folderGroups.length">
            <div class="side-label">
              <span>Folders</span>
              <button v-if="canFolder" id="newFolder" class="icon-btn" type="button" aria-label="New folder" title="New folder"
                      @click="openFolderDialog(null, 'new')"><Icon name="folderPlus" /></button>
            </div>
            <div v-for="g in folderGroups" :key="g.folder" class="chat-folder-wrap" :class="{ 'menu-open': folderMenu === g.folder }">
            <!-- The menu sits outside <details>: a closed one renders nothing but its summary. -->
            <!-- Anchored to the heading's height, not the folder: open, the folder runs on under its chats. -->
            <div v-if="folderMenu === g.folder" class="row-anchor">
            <Popover side="right" class="row-menu folder-menu" :aria-label="`Folder “${g.folder}”`">
              <button type="button" class="pop-item" role="menuitem" @click="newChatIn(g.folder)"><Icon name="new" /><span class="pop-name">New chat here</span></button>
              <button type="button" class="pop-item" role="menuitem" @click="openFolderDialog(g.folder, 'chats')"><Icon name="folderOpen" /><span class="pop-name">Add or take out chats</span></button>
              <button type="button" class="pop-item" role="menuitem" @click="openFolderDialog(g.folder, 'edit')"><Icon name="edit" /><span class="pop-name">Name and instructions</span></button>
              <hr class="pop-sep">
              <button type="button" class="pop-item pop-danger" role="menuitem" @click="openFolderDialog(g.folder, 'delete')"><Icon name="trash" /><span class="pop-name">Delete folder</span></button>
            </Popover>
            </div>
            <details class="chat-folder" :open="chats.expanded.has(g.folder)" @toggle="toggleFolder(g.folder, $event)">
              <summary class="chat-folder-heading">
                <Icon class="folder-icon" :name="chats.expanded.has(g.folder) ? 'folderOpen' : 'folder'" />
                <span class="chat-folder-name">{{ g.folder }}</span>
                <span v-if="chats.prompts[g.folder]" class="folder-mark" title="Has its own instructions"><Icon name="instructions" size=".75rem" /></span>
                <span class="chat-folder-count" :aria-label="`${g.count} chats`">{{ g.count }}</span>
                <span class="folder-actions">
                  <button class="folder-action folder-options" type="button" title="Folder options"
                          :aria-label="`Options for folder “${g.folder}”`" aria-haspopup="menu" :aria-expanded="folderMenu === g.folder"
                          @click.prevent.stop="folderMenu = folderMenu === g.folder ? null : g.folder" @keydown.stop><Icon name="more" /></button>
                </span>
              </summary>
              <div class="chat-folder-content">
                <template v-for="row in g.rows" :key="row.key">
                  <ChatItem v-if="row.kind === 'chat'" :chat="row.chat" :depth="row.depth" :active="row.chat.id === currentId"
                            @open="openChat(row.chat.id)" />
                </template>
                <div v-if="!g.count" class="folder-empty">
                  <span>Empty.</span>
                  <button type="button" class="link" @click="newChatIn(g.folder)">Start a chat</button>
                  <template v-if="canFolder && chats.chats.length"> or <button type="button" class="link" @click="openFolderDialog(g.folder, 'chats')">bring some in</button></template>
                </div>
              </div>
            </details>
            </div>
          </template>
          <!-- With no folders yet, New folder rides on the first heading there is. -->
          <div v-if="!looseRows.length && !folderGroups.length" class="side-label">
            <span>Chats</span>
            <button v-if="canFolder" id="newFolder" class="icon-btn" type="button" aria-label="New folder" title="New folder"
                    @click="openFolderDialog(null, 'new')"><Icon name="folderPlus" /></button>
          </div>
          <div v-if="empty" class="empty">No saved chats yet</div>
          <template v-for="(row, i) in looseRows" :key="row.key">
            <div v-if="row.kind === 'heading'" class="side-label">
              <span>{{ row.label }}</span>
              <button v-if="i === 0 && canFolder && !folderGroups.length" id="newFolder" class="icon-btn" type="button" aria-label="New folder" title="New folder"
                      @click="openFolderDialog(null, 'new')"><Icon name="folderPlus" /></button>
            </div>
            <ChatItem v-else :chat="row.chat" :depth="row.depth" :active="row.chat.id === currentId"
                      @open="openChat(row.chat.id)" />
          </template>
        </template>
      </div>
    </div>
    <div v-if="showAccount" ref="accountEl" class="side-foot">
      <Popover v-if="accountOpen" ref="accountPop" side="left" class="account-menu" aria-label="Account">
        <!-- The button already names you; only an email it does not show is worth a line here. -->
        <div v-if="user?.name && user.email" class="account-who">
          <span class="account-who-sub">{{ user.email }}</span>
        </div>
        <button v-if="hasSettings" id="openSettings" type="button" class="pop-item" role="menuitem" @click="openSettings">
          <Icon name="settings" /><span class="pop-name">Settings</span>
          <span v-if="admin.waiting" class="adm-badge" :title="`${admin.waiting} waiting for approval`">{{ admin.waiting }}</span>
        </button>
        <hr v-if="hasSettings" class="pop-sep">
        <button id="logout" type="button" class="pop-item" role="menuitem" @click="session.logout()">
          <Icon name="logout" /><span class="pop-name">Log out</span>
        </button>
      </Popover>
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
    <FolderDialog v-if="folderDialog" :folder="folderDialog.folder" :mode="folderDialog.mode" @close="folderDialog = undefined" />
  </aside>
</template>
