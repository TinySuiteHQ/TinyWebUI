/**
 * Document attachments: files picked, dropped, or pasted are only staged
 * client-side -- nothing is uploaded, extracted, or written to the store
 * until the message is actually sent. Before that, removing one just drops
 * it from the local queue; there is nothing server-side to clean up.
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
  label.textContent = 'sources';
  box.appendChild(label);

  const shown = docsExpanded ? state.chatDocuments : state.chatDocuments.slice(0, DOC_PREVIEW_COUNT);
  for (const d of shown) {
    const item = el('button', 'rail-item');
    item.type = 'button';
    item.title = `${d.filename} · ${d.char_len.toLocaleString('en-US')} chars`;
    const icon = el('span', 'icon');
    icon.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">'
      + '<path d="M4 1.5h5.5L12.5 4.5V14.5H4z"/><path d="M9.5 1.5V4.5H12.5"/>'
      + '<path d="M5.75 8h4.5M5.75 10.25h4.5M5.75 12h3"/></svg>';
    const name = el('span', 'text');
    name.textContent = d.filename;
    item.append(icon, name);
    item.onclick = () => openDocument(d.id);
    box.appendChild(item);
  }

  const hidden = state.chatDocuments.length - shown.length;
  if (hidden > 0 || docsExpanded && state.chatDocuments.length > DOC_PREVIEW_COUNT) {
    const more = el('button', 'rail-more');
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
    const chip = el('span', 'attachment-chip');
    chip.textContent = a.file.name;
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

/** Queues a file (or a pasted-text stand-in) client-side. No network yet. */
export function stageAttachment(file) {
  state.pendingAttachments.push({ file });
  renderAttachments();
}

/**
 * Uploads every staged file now that the message is actually being sent --
 * this is the first point any of it is extracted or written to the store.
 * A failed upload is reported and left out rather than blocking the rest.
 */
export async function commitAttachments(chatId) {
  const staged = state.pendingAttachments;
  state.pendingAttachments = [];
  renderAttachments();
  const docs = [];
  for (const { file } of staged) {
    try {
      const dataBase64 = await toBase64(file);
      // The chat may not exist yet -- the upload route creates it lazily, the
      // same way the first /api/chat call does.
      const res = await fetch(`/api/chats/${chatId}/documents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename: file.name, mime: file.type, dataBase64 })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'upload failed');
      docs.push(data.document);
    } catch (err) {
      addError(`attach "${file.name}": ${err.message}`);
    }
  }
  if (docs.length) {
    state.chatDocuments.push(...docs);
    renderChatDocs();
  }
  return docs;
}

$('attach').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', () => {
  for (const f of $('fileInput').files) stageAttachment(f);
  $('fileInput').value = '';
});

for (const ev of ['dragover', 'dragenter']) {
  $('form').addEventListener(ev, (e) => e.preventDefault());
}
$('form').addEventListener('drop', (e) => {
  e.preventDefault();
  for (const f of e.dataTransfer.files) stageAttachment(f);
});

// A long paste reads like ChatGPT's: it becomes an attachment instead of
// filling the box with a wall of text the user would have to scroll past.
const PASTE_AS_FILE_THRESHOLD = 2000;
input.addEventListener('paste', (e) => {
  const text = e.clipboardData?.getData('text/plain') || '';
  if (text.length < PASTE_AS_FILE_THRESHOLD) return;
  e.preventDefault();
  stageAttachment(new File([text], 'pasted.txt', { type: 'text/plain' }));
});
