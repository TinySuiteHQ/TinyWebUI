/**
 * Document attachments: the chip row for what's queued to send, the strip of
 * everything ever attached to the open chat, and the upload path shared by
 * the paperclip button, drag-and-drop, and the paste-as-file shortcut.
 */
import { $, el } from './dom.js';
import { state } from './state.js';
import { addError } from './transcript.js';

const input = $('input');
const DOC_PREVIEW_COUNT = 3;
let docsExpanded = false;

/** Opens a document's full extracted text in a new tab, plain-text. */
async function openDocument(id) {
  try {
    const res = await fetch(`/api/documents/${id}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'could not load document');
    const blob = new Blob([data.content], { type: 'text/plain;charset=utf-8' });
    window.open(URL.createObjectURL(blob), '_blank');
  } catch (err) {
    addError(`open "${id}": ${err.message}`);
  }
}

export function renderChatDocs() {
  const box = $('chatDocs');
  box.innerHTML = '';
  box.hidden = state.chatDocuments.length === 0;
  if (!state.chatDocuments.length) return;

  const label = el('span', 'label');
  label.textContent = state.chatDocuments.length === 1 ? 'file' : 'files';
  box.appendChild(label);

  const shown = docsExpanded ? state.chatDocuments : state.chatDocuments.slice(0, DOC_PREVIEW_COUNT);
  for (const d of shown) {
    const item = el('button', 'doc-item');
    item.type = 'button';
    item.title = `${d.filename} · ${d.char_len.toLocaleString('en-US')} chars`;
    item.textContent = d.filename;
    item.onclick = () => openDocument(d.id);
    box.appendChild(item);
  }

  const hidden = state.chatDocuments.length - shown.length;
  if (hidden > 0 || docsExpanded && state.chatDocuments.length > DOC_PREVIEW_COUNT) {
    const more = el('button', 'doc-more');
    more.type = 'button';
    more.textContent = docsExpanded ? 'show less' : `+${hidden} more`;
    more.onclick = () => { docsExpanded = !docsExpanded; renderChatDocs(); };
    box.appendChild(more);
  }
}

/** Called when switching chats, so a new chat doesn't inherit the last one's state. */
export function resetChatDocsView() {
  docsExpanded = false;
}

export function renderAttachments() {
  const box = $('attachments');
  box.innerHTML = '';
  box.hidden = state.pendingAttachments.length === 0;
  for (const a of state.pendingAttachments) {
    const chip = el('span', 'attachment-chip' + (a.pending ? ' pending' : ''));
    chip.textContent = a.pending ? `${a.filename}…` : `${a.filename} (${a.char_len.toLocaleString('en-US')} chars)`;
    const remove = el('span', 'remove');
    remove.textContent = '✕';
    remove.title = 'remove attachment';
    remove.onclick = () => {
      state.pendingAttachments = state.pendingAttachments.filter((x) => x !== a);
      renderAttachments();
    };
    chip.appendChild(remove);
    box.appendChild(chip);
  }
}

function toBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Uploads one file (or a pasted-text stand-in) and adds/updates its chip. */
export async function uploadAttachment(file) {
  const slot = { id: null, filename: file.name, char_len: 0, pending: true };
  state.pendingAttachments.push(slot);
  renderAttachments();
  // Assigned synchronously (before any await) so two files dropped together
  // both land on the same not-yet-created chat rather than each creating one.
  if (!state.chat.id) state.chat.id = 'c-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  try {
    const dataBase64 = await toBase64(file);
    // The chat may not exist yet -- the upload route creates it lazily, the
    // same way the first /api/chat call does.
    const res = await fetch(`/api/chats/${state.chat.id}/documents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: file.name, mime: file.type, dataBase64 })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'upload failed');
    slot.id = data.document.id;
    slot.char_len = data.document.char_len;
    slot.pending = false;
    state.chatDocuments.push({ id: data.document.id, filename: data.document.filename, char_len: data.document.char_len });
    renderChatDocs();
  } catch (err) {
    state.pendingAttachments = state.pendingAttachments.filter((x) => x !== slot);
    addError(`attach "${file.name}": ${err.message}`);
  }
  renderAttachments();
}

$('attach').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', () => {
  for (const f of $('fileInput').files) uploadAttachment(f);
  $('fileInput').value = '';
});

for (const ev of ['dragover', 'dragenter']) {
  $('form').addEventListener(ev, (e) => e.preventDefault());
}
$('form').addEventListener('drop', (e) => {
  e.preventDefault();
  for (const f of e.dataTransfer.files) uploadAttachment(f);
});

// A long paste reads like ChatGPT's: it becomes an attachment instead of
// filling the box with a wall of text the user would have to scroll past.
const PASTE_AS_FILE_THRESHOLD = 2000;
input.addEventListener('paste', (e) => {
  const text = e.clipboardData?.getData('text/plain') || '';
  if (text.length < PASTE_AS_FILE_THRESHOLD) return;
  e.preventDefault();
  const file = new File([text], 'pasted.txt', { type: 'text/plain' });
  uploadAttachment(file);
});
