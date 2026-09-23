/**
 * Owns which chat is open and the form that sends into it -- the orchestrator
 * that ties the transcript, the attachment tray and the sidebar together.
 */
import { $ } from './dom.js';
import { state } from './state.js';
import { addUser, replay, addError, pinToBottom } from './transcript.js';
import { consume } from './stream.js';
import { commitAttachments, renderAttachments, renderChatDocs, resetChatDocsView } from './attachments.js';
import { loadChats, clearSearch, closeSideDrawer } from './sidebar.js';
import { resetOutline } from './outline.js';

const input = $('input');

input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 190) + 'px';
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('form').requestSubmit(); }
});

/** Cancels whatever stream read the view currently on screen owns. */
function leaveView() {
  state.viewCtrl?.abort();
  state.viewCtrl = null;
  if (state.busy) setBusy(false);
}

export function newChat() {
  leaveView();
  state.chat = { id: null, title: 'New chat' };
  $('wrap').innerHTML = '';
  pinToBottom();
  state.pendingAttachments = [];
  renderAttachments();
  state.chatDocuments = [];
  state.chatImages = [];
  resetChatDocsView();
  renderChatDocs();
  resetOutline();
  // Starting fresh is a clear signal that browsing is done; a lingering
  // search would otherwise still be sitting over the sidebar underneath it,
  // and on mobile the drawer would otherwise still be covering the composer.
  clearSearch();
  closeSideDrawer();
}

export async function openChat(id) {
  const res = await fetch(`/api/chats/${id}`);
  if (!res.ok) return;
  const found = await res.json();
  leaveView();
  state.chat = { id: found.id, title: found.title };
  $('wrap').innerHTML = '';
  pinToBottom();
  state.pendingAttachments = [];
  renderAttachments();
  state.chatDocuments = found.documents || [];
  // No dedicated images endpoint -- every image already rides inline on the
  // user message that attached it, so the rail is built from the same
  // history the transcript renders rather than a second round trip.
  state.chatImages = (found.messages || [])
    .filter((m) => m.role === 'user' && m.images?.length)
    .flatMap((m) => m.images);
  resetChatDocsView();
  renderChatDocs();
  resetOutline();
  // Mid-turn, the server hands back only the settled part of the transcript;
  // the rest arrives as events, exactly as it did for the tab that started it.
  replay(found.messages);
  clearSearch();
  closeSideDrawer();
  if (found.running) rejoin(id);
}

/** Follows a turn already in flight, from the top of its event buffer. */
async function rejoin(id) {
  const ctrl = new AbortController();
  state.viewCtrl = ctrl;
  setBusy(true);
  try {
    const res = await fetch(`/api/chats/${id}/stream?from=0`, { signal: ctrl.signal });
    if (res.ok) await consume(res);
  } catch (err) {
    // Navigating away aborts this on purpose; anything else just means the
    // transcript is in the store and reopening picks it up.
  }
  // A later navigation already swapped in its own controller and reset
  // `busy` for its own view -- stepping on either here would be wrong.
  if (state.viewCtrl === ctrl) {
    state.viewCtrl = null;
    setBusy(false);
    loadChats();
  }
}

const SVG = (d) => `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const SEND_ICON = SVG('<path d="M12 19V5M5 12l7-7 7 7"/>');
const STOP_ICON = SVG('<rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor"/>');

/** While a turn runs, send becomes stop -- the run outlives this tab either way. */
function setBusy(on) {
  state.busy = on;
  // Icon-only button: the arrow sends, the square stops; the label says which.
  $('send').innerHTML = on ? STOP_ICON : SEND_ICON;
  $('send').setAttribute('aria-label', on ? 'Stop' : 'Send');
  $('send').classList.toggle('stop', on);
  if (!on) input.focus();
}

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (state.busy) {
    // Closing the tab no longer stops a turn, so there has to be a way to
    // actually mean it.
    if (state.chat.id) await fetch(`/api/chats/${state.chat.id}/stop`, { method: 'POST' });
    return;
  }
  const text = input.value.trim();
  const hasAttachments = state.pendingAttachments.length > 0;
  if (!text && !hasAttachments) return;
  input.value = '';
  input.style.height = 'auto';
  setBusy(true);
  const ctrl = new AbortController();
  state.viewCtrl = ctrl;

  // Assigned synchronously (before any await) so the upload below and the
  // /api/chat call after it land on the same not-yet-created chat.
  if (!state.chat.id) state.chat.id = 'c-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  // This is the first point anything staged is actually uploaded, extracted
  // and written to the store -- removing a chip before now never touched it.
  const { docs, images } = await commitAttachments(state.chat.id);
  if (!text && !docs.length && !images.length) { setBusy(false); return; }

  const placeholder = !text ? (images.length ? '(attached image)' : '(attached document)') : text;
  addUser(placeholder, null, docs, images);

  try {
    // Only the new turn goes up. The server replays the rest from its own copy,
    // so a page-sized tool result crosses the wire once rather than every turn.
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chatId: state.chat.id,
        message: placeholder,
        documentIds: docs.map((a) => a.id),
        images
      }),
      signal: ctrl.signal
    });
    await consume(res);
    loadChats();
  } catch (err) {
    if (err.name !== 'AbortError') addError(err.message);
  } finally {
    // A later navigation already swapped in its own controller and reset
    // `busy` for its own view -- stepping on either here would be wrong.
    if (state.viewCtrl === ctrl) {
      state.viewCtrl = null;
      setBusy(false);
    }
  }
});

// A run is the server's, so the dot in the sidebar can change without this tab
// doing anything at all. Poll only while there is something to watch.
setInterval(async () => {
  if (!state.busy && !state.chats.some((c) => c.running)) return;
  await loadChats();
  const id = state.chat?.id;
  if (!state.busy && id && state.chats.some((chat) => chat.id === id && chat.running)) rejoin(id);
}, 4000);
