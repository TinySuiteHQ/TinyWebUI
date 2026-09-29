/**
 * Owns which chat is open and the form that sends into it -- the orchestrator
 * that ties the transcript, the attachment tray and the sidebar together.
 */
import { $ } from '../core/dom.js';
import { state } from '../core/state.js';
import { addUser, replay, addError, pinToBottom } from './transcript.js';
import { consume } from './stream.js';
import { commitAttachments, invalidAttachments, renderAttachments, renderChatDocs, resetChatDocsView } from './attachments.js';
import { loadChats, clearSearch, closeSideDrawer } from './sidebar.js';
import { resetOutline } from './outline.js';
import { renderTasks } from './tasks.js';
import { renderQueue, enqueue, reclaimQueue, holdFollowup } from './queue.js';
import { api } from '../core/api.js';
import { newId } from '../core/id.js';

const input = $('input');
let chatLoadCtrl = null;

function cancelChatLoad() {
  chatLoadCtrl?.abort();
  chatLoadCtrl = null;
}

export function initChat() {
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 190) + 'px';
    if (state.busy) setBusy(true);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    e.preventDefault();
    // While a turn runs, Alt+Enter holds it for later; plain Enter steers it.
    if (e.altKey && state.busy) holdInput();
    else $('form').requestSubmit();
  });
  $('form').addEventListener('submit', onSubmit);

  // A run is the server's, so the dot in the sidebar can change without this tab
  // doing anything at all. Poll only while there is something to watch.
  setInterval(async () => {
    if (!state.busy && !state.chats.some((c) => c.running)) return;
    await loadChats();
    const id = state.chat?.id;
    if (!state.busy && id && state.chats.some((chat) => chat.id === id && chat.running)) rejoin(id);
  }, 4000);
}

/** Parks what is typed above the composer until its send button is clicked. */
function holdInput() {
  const text = input.value.trim();
  if (!text || !state.chat.id) return;
  input.value = '';
  input.dispatchEvent(new Event('input'));
  holdFollowup(text);
}

/** A held follow-up, confirmed: into the running turn, or as the next message. */
export function sendHeld(text) {
  if (!state.busy) input.value = [text, input.value.trim()].filter(Boolean).join('\n\n');
  else input.value = text;
  queueOrSend();
}

function queueOrSend() {
  if (state.busy) queueInput('steer');
  else $('form').requestSubmit();
}

/** Sends what is typed to the running turn instead of starting a new one. */
async function queueInput(kind) {
  const text = input.value.trim();
  if (!text || !state.chat.id) return;
  input.value = '';
  input.dispatchEvent(new Event('input'));
  // 409: the turn finished in the meantime, so this is just the next message.
  if (!(await enqueue(kind, text))) {
    input.value = text;
    setBusy(false);
    $('form').requestSubmit();
  }
}

/** After a stream ends: follow the run a follow-up started, or take back what never went. */
async function afterRun({ next } = {}, id) {
  if (next && state.chat.id === id) return rejoin(id);
  if (state.chat.id === id) await reclaimQueue();
  return undefined;
}

/** Cancels whatever stream read the view currently on screen owns. */
function leaveView() {
  state.viewCtrl?.abort();
  state.viewCtrl = null;
  if (state.busy) setBusy(false);
  renderQueue([]);
}

export function newChat() {
  cancelChatLoad();
  leaveView();
  state.chat = { id: null, title: 'New chat' };
  renderTasks();
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
  // A slower earlier click must never replace the chat selected most recently.
  cancelChatLoad();
  const ctrl = new AbortController();
  chatLoadCtrl = ctrl;
  let found;
  try {
    found = await api.get(`/api/chats/${id}`, { signal: ctrl.signal });
  } catch (err) {
    if (chatLoadCtrl === ctrl) {
      chatLoadCtrl = null;
      if (err.name !== 'AbortError') addError(`Could not open chat (${err.message})`);
    }
    return;
  }
  if (chatLoadCtrl !== ctrl) return;
  chatLoadCtrl = null;
  leaveView();
  state.chat = { id: found.id, title: found.title };
  renderTasks(found.tasks || []);
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
  renderQueue(found.queued || []);
  clearSearch();
  closeSideDrawer();
  if (found.running) rejoin(id);
  else reclaimQueue();
}

/** Follows a turn already in flight, from the top of its event buffer. */
async function rejoin(id) {
  const ctrl = new AbortController();
  state.viewCtrl = ctrl;
  setBusy(true);
  let outcome;
  try {
    const res = await fetch(`/api/chats/${id}/stream?from=0`, { signal: ctrl.signal });
    if (res.ok) outcome = await consume(res);
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
    await afterRun(outcome, id);
  }
}

const SVG = (d) => `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const SEND_ICON = SVG('<path d="M12 19V5M5 12l7-7 7 7"/>');
const STOP_ICON = SVG('<rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor"/>');

/**
 * While a turn runs, send becomes stop -- the run outlives this tab either
 * way -- unless something is typed, which the arrow then queues on the turn.
 */
function setBusy(on) {
  const wasBusy = state.busy;
  state.busy = on;
  const stop = on && !input.value.trim();
  // Icon-only button: the arrow sends, the square stops; the label says which.
  $('send').innerHTML = stop ? STOP_ICON : SEND_ICON;
  $('send').setAttribute('aria-label', stop ? 'Stop' : on ? 'Queue message (Alt+Enter: hold for later)' : 'Send');
  $('send').title = on && !stop ? 'Enter: next step · Alt+Enter: hold for later' : '';
  $('send').classList.toggle('stop', stop);
  input.placeholder = on ? 'Add a message to this turn…' : 'Type a message…';
  if (!on && wasBusy) input.focus();
}

async function onSubmit(e) {
  e.preventDefault();
  if (state.busy) {
    if (input.value.trim()) return queueInput('steer');
    // Closing the tab no longer stops a turn, so there has to be a way to
    // actually mean it.
    if (!state.chat.id) return;
    try {
      await api.post(`/api/chats/${state.chat.id}/stop`);
    } catch (err) { addError(`couldn't stop: ${err.message}`); }
    return;
  }
  const text = input.value.trim();
  const hasAttachments = state.pendingAttachments.length > 0;
  if (!text && !hasAttachments) return;
  // A message must never go out without an attachment the user thinks is on
  // it -- the model would act on the text alone.
  const invalid = hasAttachments ? await invalidAttachments() : [];
  if (invalid.length) {
    addError(`remove ${invalid.map((a) => `"${a.file.name}"`).join(', ')} before sending`);
    return;
  }
  input.value = '';
  input.style.height = 'auto';
  setBusy(true);
  const ctrl = new AbortController();
  state.viewCtrl = ctrl;

  // Assigned synchronously (before any await) so the upload below and the
  // /api/chat call after it land on the same not-yet-created chat.
  if (!state.chat.id) state.chat.id = newId();
  // This is the first point anything staged is actually uploaded, extracted
  // and written to the store -- removing a chip before now never touched it.
  const { docs, images, failed } = await commitAttachments(state.chat.id);
  if (failed.length) {
    input.value = text;
    setBusy(false);
    return;
  }
  if (!text && !docs.length && !images.length) { setBusy(false); return; }

  const placeholder = !text ? (images.length ? '(attached image)' : '(attached document)') : text;
  addUser(placeholder, null, docs, images);

  let outcome;
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
    outcome = await consume(res);
    loadChats();
  } catch (err) {
    if (err.name !== 'AbortError') addError(err.message);
  } finally {
    // A later navigation already swapped in its own controller and reset
    // `busy` for its own view -- stepping on either here would be wrong.
    if (state.viewCtrl === ctrl) {
      state.viewCtrl = null;
      setBusy(false);
      afterRun(outcome, state.chat.id);
    }
  }
}
