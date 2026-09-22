/**
 * The chat-history sidebar: the draggable width, the chronological list, the
 * full-text search that swaps in over it, and the mobile drawer it lives in.
 */
import { $, el } from './dom.js';
import { state } from './state.js';
import { openChat, newChat } from './chat.js';

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

(function initSideResize() {
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
}());

/* ---------- history: server-side, newest first ---------- */

/** ChatGPT-style buckets: today, yesterday, then widening rolling windows,
    then by calendar month once a chat is old enough that "N days ago" stops
    being a useful unit. */
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

export function renderChatList() {
  $('chats').innerHTML = '';
  // The draft in progress isn't a chat on the server yet -- it gets a row
  // only so the list shows where you are, never a second one on the next
  // click. It disappears the moment the draft becomes a real chat or is
  // abandoned for one that already exists.
  if (state.chat && !state.chat.id) {
    const row = el('div', 'chat-item active draft');
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-current', 'true');
    const t = el('span', 't');
    t.textContent = state.chat.title || 'New chat';
    row.appendChild(t);
    $('chats').appendChild(row);
  }
  if (!state.chats.length) {
    if (state.chat && !state.chat.id) return;
    const e = el('div', 'empty');
    e.textContent = 'no saved chats';
    return $('chats').appendChild(e);
  }
  const now = Date.now();
  let lastBucket = null;
  for (const c of state.chats) {
    // The list is already newest-first, so a bucket only opens once, right
    // where its first chat falls -- no separate grouping/sorting pass needed.
    const bucket = bucketOf(c.updated_at, now);
    if (bucket !== lastBucket) {
      lastBucket = bucket;
      const h = el('div', 'chat-group-h');
      h.textContent = bucket;
      $('chats').appendChild(h);
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
    const x = el('button', 'x');
    x.textContent = '×';
    x.title = `Delete "${c.title}"`;
    x.setAttribute('aria-label', `Delete "${c.title}"`);
    x.onclick = async (e) => {
      e.stopPropagation();
      await fetch(`/api/chats/${c.id}`, { method: 'DELETE' });
      await loadChats();
      if (state.chat && state.chat.id === c.id) newChat();
    };
    row.prepend(t);
    row.append(x);
    row.onclick = () => openChat(c.id);
    row.onkeydown = (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault(); // space would scroll the list instead
      openChat(c.id);
    };
    $('chats').appendChild(row);
  }
}

export async function loadChats() {
  try {
    const res = await (await fetch('/api/chats')).json();
    state.chats = res.chats || [];
  } catch { state.chats = []; }
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
    results = (await (await fetch(`/api/search?q=${encodeURIComponent(q)}`)).json()).results || [];
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
function setSideDrawer(open) {
  $('side').classList.toggle('open', open);
  $('side-backdrop').classList.toggle('open', open);
  $('menu').setAttribute('aria-expanded', String(open));
}
export const closeSideDrawer = () => setSideDrawer(false);

$('menu').onclick = () => setSideDrawer(!$('side').classList.contains('open'));
$('side-backdrop').onclick = closeSideDrawer;
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('side').classList.contains('open')) closeSideDrawer();
});

$('new').onclick = newChat;
