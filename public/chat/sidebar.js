/**
 * The chat-history sidebar: the draggable width, the chronological list, the
 * full-text search that swaps in over it, and the mobile drawer it lives in.
 */
import { $, el } from '../core/dom.js';
import { state } from '../core/state.js';
import { api } from '../core/api.js';

let organizingChatId = null;
const expandedFolders = new Set();
// Marks the draft row's slot in a folder's chat list -- a distinct object
// rather than `null`, so it can't be confused with "no such folder" (a real
// Map lookup miss) or any other falsy value a chat row might someday carry.
const DRAFT = Symbol('draft');

/* ---------- sidebar width ---------- */

/**
 * A draggable sidebar, remembered per browser.
 *
 * The width lives in a CSS variable rather than an inline style so the
 * stylesheet keeps ownership of the default: clearing the variable is what
 * resets it, and nothing here needs to know what 15rem is.
 */
const SIDE_KEY = 'tinywebui.sideWidth';
const SIDE_MIN = 176;
const SIDE_MAX = 560;

function setSideWidth(px) {
  const clamped = Math.round(Math.min(SIDE_MAX, Math.max(SIDE_MIN, px)));
  document.documentElement.style.setProperty('--side-w', `${clamped}px`);
  // Per-viewer convenience only, and blocked or full storage must not take the
  // sidebar with it.
  try { localStorage.setItem(SIDE_KEY, String(clamped)); } catch { /* not important enough to fail over */ }
  return clamped;
}

function resetSideWidth() {
  document.documentElement.style.removeProperty('--side-w');
  try { localStorage.removeItem(SIDE_KEY); } catch { /* as above */ }
}

/* ---------- history: server-side, newest first ---------- */

export function renderChatList() {
  $('chats').innerHTML = '';
  const isDraft = state.chat && !state.chat.id;
  if (!state.chats.length && !isDraft && !state.folders.length) {
    const e = el('div', 'empty');
    e.textContent = 'no saved chats';
    return $('chats').appendChild(e);
  }
  const groups = new Map();
  // A folder just created and not yet moved into is still a real folder --
  // it needs a row of its own, not just a spot in the organize dropdown.
  for (const name of state.folders) groups.set(name, []);
  for (const c of state.chats) {
    const folder = (c.folder || '').trim() || null;
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder).push(c);
  }
  // The draft in progress isn't a chat on the server yet -- it gets a row
  // only so the list shows where you are, never a second one on the next
  // click. It disappears the moment the draft becomes a real chat or is
  // abandoned for one that already exists. It always lands in the ungrouped
  // "Today" bucket, never inside a folder it hasn't been organized into.
  if (isDraft) {
    if (!groups.has(null)) groups.set(null, []);
    groups.get(null).unshift(DRAFT);
  }
  const folderNames = [...groups.keys()].sort((a, b) => a === null ? 1 : b === null ? -1 : a.localeCompare(b));
  const now = Date.now();
  for (const folder of folderNames) {
    let contents = $('chats');
    if (folder) {
      // Every folder starts collapsed -- with more than a couple of them,
      // auto-opening turns the sidebar into a wall of chats.
      const section = el('details', 'chat-folder');
      section.open = expandedFolders.has(folder);
      section.addEventListener('toggle', () => {
        if (section.open) expandedFolders.add(folder);
        else expandedFolders.delete(folder);
      });
      const heading = el('summary', 'chat-folder-heading');
      const name = el('span', 'chat-folder-name'); name.textContent = folder;
      const count = el('span', 'chat-folder-count'); count.textContent = String(groups.get(folder).length);
      heading.append(name, count);
      section.appendChild(heading);
      contents = el('div', 'chat-folder-content');
      section.appendChild(contents);
      $('chats').appendChild(section);
    }
    let lastBucket = null;
    for (const c of groups.get(folder)) {
      if (c === DRAFT) {
        if (lastBucket !== 'Today') {
          lastBucket = 'Today';
          const dateHeading = el('div', 'chat-date-heading');
          dateHeading.textContent = 'Today';
          contents.appendChild(dateHeading);
        }
        const row = el('div', 'chat-item active draft');
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        row.setAttribute('aria-current', 'true');
        const t = el('span', 't');
        t.textContent = state.chat.title || 'New chat';
        row.appendChild(t);
        contents.appendChild(row);
        continue;
      }
    const bucket = bucketOf(c.updated_at, now);
    if (bucket !== lastBucket) {
      lastBucket = bucket;
      const dateHeading = el('div', 'chat-date-heading');
      dateHeading.textContent = bucket;
      contents.appendChild(dateHeading);
    }
    const row = el('div', 'chat-item' + (state.chat && c.id === state.chat.id ? ' active' : ''));
    // A div with an onclick is unreachable without a mouse, so the row carries
    // the button contract explicitly: focusable, named, and activated by key.
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    if (state.chat && c.id === state.chat.id) row.setAttribute('aria-current', 'true');
    const t = el('span', 't');
    t.textContent = c.title;
    // A turn is the server's, not this tab's, so a chat can be working while
    // nothing is watching it -- including a chat opened in another window.
    if (c.running) {
      const dot = el('span', 'dot');
      dot.title = 'working';
      dot.setAttribute('aria-label', 'working');
      row.appendChild(dot);
    }
    const organize = el('button', 'organize-chat');
    organize.type = 'button';
    organize.textContent = '⋯';
    organize.title = 'Chat options';
    organize.setAttribute('aria-label', `Options for "${c.title}"`);
    organize.onclick = (e) => {
      e.stopPropagation();
      organizingChatId = c.id;
      fillOrganizeFolders(c.folder || '');
      $('organizeError').hidden = true;
      $('organizeDelete').title = `Delete "${c.title}"`;
      $('organizeDelete').setAttribute('aria-label', `Delete "${c.title}"`);
      $('organizeDialog').showModal();
      $('organizeFolder').focus();
    };
    organize.onkeydown = (e) => e.stopPropagation();
    row.prepend(t);
    row.append(organize);
    row.onclick = () => openChat(c.id);
    row.onkeydown = (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault(); // space would scroll the list instead
      openChat(c.id);
    };
    contents.appendChild(row);
    }
  }
}

/** Recent chats get familiar rolling buckets; older chats use calendar months. */
function bucketOf(updatedAt, now) {
  const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const days = Math.round((startOfDay(now) - startOfDay(updatedAt)) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days <= 7) return 'Previous 7 days';
  if (days <= 30) return 'Previous 30 days';
  const d = new Date(updatedAt);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString('en-US', sameYear ? { month: 'long' } : { month: 'long', year: 'numeric' });
}

let chatsRequest = 0;

export async function loadChats() {
  // Many callers (polls, stream ends, edits) overlap; only the newest call
  // may write, or an older list could land last and drop a just-made chat.
  const request = ++chatsRequest;
  const [chats, folders] = await Promise.allSettled([api.get('/api/chats'), api.get('/api/folders')]);
  if (request !== chatsRequest) return;
  // On failure keep whatever is already on screen rather than blanking it.
  if (chats.status === 'fulfilled') state.chats = chats.value.chats || [];
  if (folders.status === 'fulfilled') state.folders = folders.value.folders || [];
  // A background poll (the running-dot refresh) must not clobber search
  // results the user is looking at with the plain chronological list.
  refreshSidebar();
}

/* ---------- search ---------- */

let searchQuery = '';
let searchResults = null;
let searchSeq = 0;

/** Redraws whichever view is current -- search results, or the plain list. */
function refreshSidebar() {
  if (searchQuery && searchResults) renderSearchResults(searchResults, searchQuery);
  else renderChatList();
}

async function runSearch(q) {
  const seq = ++searchSeq;
  if (!q.trim()) {
    searchQuery = '';
    searchResults = null;
    return renderChatList();
  }
  let results = [];
  try {
    results = (await api.get(`/api/search?q=${encodeURIComponent(q)}`)).results || [];
  } catch { /* leave whatever is on screen; the next keystroke will retry */ }
  if (seq !== searchSeq) return; // a newer query landed first -- this one is stale
  searchQuery = q;
  searchResults = results;
  renderSearchResults(results, q);
}

/** Turns snippet()'s ‹...› markers into <mark>, escaping everything else. */
function markSnippet(raw) {
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return raw.split('‹').map((chunk, i) => {
    if (i === 0) return esc(chunk);
    const at = chunk.indexOf('›');
    if (at === -1) return esc(chunk); // an unmatched marker -- show it plainly rather than eat it
    return `<mark>${esc(chunk.slice(0, at))}</mark>${esc(chunk.slice(at + 1))}`;
  }).join('');
}

const SEARCH_ROLE_LABEL = { user: 'you', assistant: 'assistant', tool: 'tool' };

function renderSearchResults(results, query) {
  $('chats').innerHTML = '';
  if (!results.length) {
    const e = el('div', 'empty');
    e.textContent = `no matches for “${query}”`;
    return $('chats').appendChild(e);
  }
  for (const r of results) {
    const row = el('div', 'chat-item search-hit');
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    const body = el('div', 't');
    const title = el('div', 'hit-title');
    title.textContent = r.chatTitle;
    const role = el('span', 'hit-role');
    role.textContent = SEARCH_ROLE_LABEL[r.role] || r.role;
    title.appendChild(role);
    const snip = el('div', 'hit-snippet');
    snip.innerHTML = markSnippet(r.snippet);
    body.append(title, snip);
    row.appendChild(body);
    const go = () => openChat(r.chatId);
    row.onclick = go;
    row.onkeydown = (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      go();
    };
    $('chats').appendChild(row);
  }
}

let searchDebounce = null;
/** Chats can only move into a folder that already exists -- create-then-move,
 * not type-a-new-name-here -- so the dropdown is rebuilt from state.folders
 * (plus the chat's own folder, in case it was removed from that list since). */
function fillOrganizeFolders(current) {
  const select = $('organizeFolder');
  select.innerHTML = '';
  const blank = el('option'); blank.value = ''; blank.textContent = '(no folder)';
  select.appendChild(blank);
  const names = current && !state.folders.includes(current)
    ? [...state.folders, current].sort((a, b) => a.localeCompare(b))
    : state.folders;
  for (const name of names) {
    const opt = el('option'); opt.value = name; opt.textContent = name;
    select.appendChild(opt);
  }
  select.value = current;
}

export function clearSearch() {
  clearTimeout(searchDebounce);
  searchSeq++; // invalidate any in-flight query so a slow reply cannot land after this
  searchQuery = '';
  searchResults = null;
  $('chatSearch').value = '';
  $('chatSearchClear').hidden = true;
  renderChatList();
}

/**
 * The mobile drawer. Three ways in beyond the menu button: tapping the
 * dimmed backdrop behind it, Escape, and picking a chat (via closeSideDrawer
 * in openChat/newChat) -- a panel with only one way to close is the kind of
 * thing that reads as broken on a phone even when it technically isn't.
 */
/**
 * Desktop hides the sidebar outright instead of opening it as a drawer; the
 * same #menu button brings it back, so it means "show sidebar" at any width.
 */
const COLLAPSE_KEY = 'tinywebui.side.collapsed';
const narrow = () => matchMedia('(max-width: 720px)').matches;

function setSideDrawer(open) {
  const side = $('side');
  const backdrop = $('side-backdrop');
  const menu = $('menu');
  const main = document.querySelector('main');
  const mobile = narrow();

  // The off-canvas sidebar remains in the DOM for its transition. Make it
  // inert while closed so keyboard users never tab into invisible controls.
  // When open, invert that boundary: Tab remains in the drawer rather than
  // reaching the obscured transcript and composer behind it.
  side.classList.toggle('open', mobile && open);
  backdrop.classList.toggle('open', mobile && open);
  side.inert = mobile && !open;
  main.inert = mobile && open;
  side.toggleAttribute('aria-hidden', mobile && !open);
  menu.setAttribute('aria-expanded', String(mobile && open));

  if (mobile && open) requestAnimationFrame(() => $('new').focus());
  if (mobile && !open && side.contains(document.activeElement)) menu.focus();
}
export const closeSideDrawer = () => setSideDrawer(false);

function setCollapsed(on) {
  document.body.classList.toggle('side-collapsed', on);
  try { on ? localStorage.setItem(COLLAPSE_KEY, '1') : localStorage.removeItem(COLLAPSE_KEY); } catch { /* per-viewer nicety only */ }
}

/* ---------- wiring ---------- */

let openChat;
let newChat;

/** `deps.openChat(id)` and `deps.newChat()` are what picking a chat, or New, does. */
export function initSidebar(deps) {
  ({ openChat, newChat } = deps);
  initSideResize();

  $('chatSearch').addEventListener('input', () => {
    const q = $('chatSearch').value;
    $('chatSearchClear').hidden = !q;
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => runSearch(q), 150);
  });
  $('chatSearch').addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('chatSearch').value) {
      e.preventDefault();
      clearSearch();
    }
  });
  $('chatSearchClear').onclick = () => { clearSearch(); $('chatSearch').focus(); };

  $('newFolder').addEventListener('click', () => {
    $('newFolderName').value = '';
    $('newFolderError').hidden = true;
    $('newFolderDialog').showModal();
    $('newFolderName').focus();
  });
  $('newFolderCancel').addEventListener('click', () => $('newFolderDialog').close());
  $('newFolderForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = $('newFolderForm').querySelector('[type="submit"]');
    button.disabled = true;
    $('newFolderError').hidden = true;
    try {
      const name = $('newFolderName').value;
      const body = await api.post('/api/folders', { name });
      $('newFolderDialog').close();
      // A freshly created folder starts open -- otherwise the workflow this
      // exists for (create it, then move chats in) hides its own result.
      expandedFolders.add(body.folder);
      await loadChats();
    } catch (err) {
      $('newFolderError').textContent = err.message || 'Could not create folder.';
      $('newFolderError').hidden = false;
    } finally {
      button.disabled = false;
    }
  });

  $('organizeCancel').addEventListener('click', () => $('organizeDialog').close());
  $('organizeDelete').addEventListener('click', async () => {
    if (!organizingChatId) return;
    const id = organizingChatId;
    try {
      await api.del(`/api/chats/${id}`);
    } catch (err) {
      $('organizeError').textContent = `Could not delete chat: ${err.message}`;
      $('organizeError').hidden = false;
      return;
    }
    $('organizeDialog').close();
    organizingChatId = null;
    await loadChats();
    if (state.chat && state.chat.id === id) newChat();
  });
  $('organizeForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!organizingChatId) return;
    const button = $('organizeForm').querySelector('[type="submit"]');
    button.disabled = true;
    $('organizeError').hidden = true;
    try {
      await api.post(`/api/chats/${organizingChatId}/organize`, { folder: $('organizeFolder').value });
      $('organizeDialog').close();
      organizingChatId = null;
      await loadChats();
    } catch (err) {
      $('organizeError').textContent = err.message || 'Could not save chat organization.';
      $('organizeError').hidden = false;
    } finally {
      button.disabled = false;
    }
  });

  try { if (localStorage.getItem(COLLAPSE_KEY)) document.body.classList.add('side-collapsed'); } catch { /* as above */ }
  $('sideCollapse').onclick = () => (narrow() ? closeSideDrawer() : setCollapsed(true));
  $('menu').onclick = () => (narrow() ? setSideDrawer(!$('side').classList.contains('open')) : setCollapsed(false));
  $('side-backdrop').onclick = closeSideDrawer;
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('side').classList.contains('open')) closeSideDrawer();
  });

  $('new').onclick = newChat;
  // The logo and name go home, which here means a fresh chat.
  $('brandHome').onclick = newChat;

  // A resize can move a currently open drawer onto the desktop layout (or vice
  // versa). Reset the inert boundary in that transition rather than leaving the
  // transcript inaccessible until the next sidebar interaction.
  matchMedia('(max-width: 720px)').addEventListener('change', () => setSideDrawer(false));
  setSideDrawer(false);
}

function initSideResize() {
  const side = $('side');
  const grip = $('side-resize');
  if (!side || !grip) return;

  try {
    const saved = Number(localStorage.getItem(SIDE_KEY));
    if (Number.isFinite(saved) && saved > 0) setSideWidth(saved);
  } catch { /* first run, or storage is unavailable; the stylesheet decides */ }

  grip.addEventListener('pointerdown', (e) => {
    // Pointer capture keeps the drag alive over the transcript, an iframe or
    // off the window edge, which a plain mousemove listener would lose.
    grip.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
    const startX = e.clientX;
    const startW = side.getBoundingClientRect().width;

    const move = (ev) => setSideWidth(startW + (ev.clientX - startX));
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
  });

  grip.addEventListener('dblclick', resetSideWidth);

  // A drag is not reachable without a pointer, so the separator is operable
  // from the keyboard too, which is also what its role promises.
  grip.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 48 : 16;
    if (e.key === 'ArrowLeft') setSideWidth(side.getBoundingClientRect().width - step);
    else if (e.key === 'ArrowRight') setSideWidth(side.getBoundingClientRect().width + step);
    else if (e.key === 'Home' || e.key === 'Escape') resetSideWidth();
    else return;
    e.preventDefault();
  });
}
