/**
 * Document attachments: files picked, dropped, or pasted are only staged
 * client-side -- nothing is uploaded, extracted, or written to the store
 * until the message is actually sent. Before that, removing one just drops
 * it from the local queue; there is nothing server-side to clean up.
 */
import { $, el } from './dom.js';
import { can } from './access.js';
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

const DOC_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">'
  + '<path d="M4 1.5h5.5L12.5 4.5V14.5H4z"/><path d="M9.5 1.5V4.5H12.5"/>'
  + '<path d="M5.75 8h4.5M5.75 10.25h4.5M5.75 12h3"/></svg>';
const IMAGE_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">'
  + '<rect x="1.5" y="2.5" width="13" height="11" rx="1"/>'
  + '<circle cx="5.5" cy="6.5" r="1.25"/><path d="M2 12l3.5-4 3 3.5 2-2.5L14 12"/></svg>';

/** Opens an image attachment full-size in a new tab, from its stored bytes. */
function openImage(img) {
  window.open(`data:${img.mime};base64,${img.data}`, '_blank');
}

/** Every document and image ever attached to this chat, oldest first. */
function artifacts() {
  return [...state.chatDocuments.map((d) => ({ kind: 'doc', ...d })),
    ...state.chatImages.map((i) => ({ kind: 'image', ...i }))];
}

export function renderChatDocs() {
  const box = $('chatDocs');
  box.innerHTML = '';
  const items = artifacts();
  box.hidden = items.length === 0;
  if (!items.length) return;

  const label = el('span', 'label');
  label.textContent = 'artifacts';
  box.appendChild(label);

  const shown = docsExpanded ? items : items.slice(0, DOC_PREVIEW_COUNT);
  for (const a of shown) {
    const item = el('button', 'rail-item');
    item.type = 'button';
    const icon = el('span', 'icon');
    if (a.kind === 'doc') {
      item.title = `${a.filename} · ${a.char_len.toLocaleString('en-US')} chars`;
      icon.innerHTML = DOC_ICON;
      item.onclick = () => openDocument(a.id);
    } else {
      item.title = a.filename || 'attached image';
      icon.innerHTML = IMAGE_ICON;
      item.onclick = () => openImage(a);
    }
    const name = el('span', 'text');
    name.textContent = a.filename || 'image';
    item.append(icon, name);
    box.appendChild(item);
  }

  const hidden = items.length - shown.length;
  if (hidden > 0 || docsExpanded && items.length > DOC_PREVIEW_COUNT) {
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
  carried = { docs: [], images: [] };
}

export function renderAttachments() {
  const box = $('attachments');
  box.innerHTML = '';
  box.hidden = state.pendingAttachments.length === 0;
  for (const a of state.pendingAttachments) {
    const chip = el('span', a.isImage ? 'attachment-chip attachment-chip-image' : 'attachment-chip');
    if (a.isImage) {
      const thumb = el('img', 'attachment-thumb');
      thumb.alt = a.file.name;
      thumb.title = a.error ? `${a.file.name}: ${a.error}` : a.file.name;
      if (a.normalized) thumb.src = `data:${a.normalized.mime};base64,${a.normalized.data}`;
      else thumb.classList.add(a.error ? 'broken' : 'pending');
      chip.appendChild(thumb);
    } else {
      chip.appendChild(document.createTextNode(a.file.name));
      if (a.error) {
        chip.classList.add('attachment-chip-error');
        chip.title = `${a.file.name}: ${a.error}`;
      }
    }
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

// Some browsers report an empty type for HEIC/AVIF, so a name-based fallback
// is what keeps those on the image path instead of the text-extraction one.
const IMAGE_EXT = /\.(heic|heif|avif|jpe?g|png|webp|gif)$/i;
function isImageFile(file) {
  return file.type.startsWith('image/') || (!file.type && IMAGE_EXT.test(file.name));
}

/**
 * Normalizes a staged image the moment it's picked, not when the message is
 * sent -- that's what lets the composer preview it and the optimistic
 * transcript thumbnail show real, decodable bytes instead of a HEIC/AVIF the
 * browser can't render, which used to show broken until the turn finished
 * and the chat reloaded with what the server had already converted.
 */
async function normalizeStaged(entry) {
  try {
    const dataBase64 = await toBase64(entry.file);
    const res = await fetch('/api/images/normalize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mime: entry.file.type, dataBase64 })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'could not read that image');
    entry.normalized = data;
  } catch (err) {
    entry.error = err.message;
  }
  renderAttachments();
}

// Mirrors what src/documents.js can extract. The server stays authoritative;
// this only exists so an obviously unusable file is flagged on its chip and
// blocks sending, instead of being discovered after the message already went.
const DOC_EXT = new Set([
  '.pdf', '.docx',
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.log',
  '.js', '.ts', '.jsx', '.tsx', '.py', '.rb', '.go', '.rs', '.java', '.c', '.cpp', '.h',
  '.css', '.html', '.xml', '.yaml', '.yml', '.sh', '.sql'
]);
function unsupportedReason(file) {
  const i = file.name.lastIndexOf('.');
  const ext = i === -1 ? '' : file.name.slice(i).toLowerCase();
  if (ext === '' || DOC_EXT.has(ext)) return null;
  if (ext === '.doc') return 'legacy .doc is not supported -- save it as .docx or .pdf';
  return `unsupported file type "${ext}"`;
}

/** Queues a file (or a pasted-text stand-in) client-side. No network yet. */
export function stageAttachment(file) {
  // Dropped and pasted files arrive here too, not only through the + menu.
  if (!can(isImageFile(file) ? 'images' : 'attachments')) {
    addError(`attach "${file.name}": ${isImageFile(file) ? 'images are' : 'attachments are'} turned off for your account`);
    return;
  }
  const entry = { file };
  if (isImageFile(file)) {
    entry.isImage = true;
    entry.ready = normalizeStaged(entry);
  } else {
    entry.error = unsupportedReason(file);
    if (entry.error) addError(`attach "${file.name}": ${entry.error}`);
  }
  state.pendingAttachments.push(entry);
  renderAttachments();
}

/**
 * Staged entries that can't be sent (unsupported type, image that failed to
 * normalize). Waits for in-flight image normalization so the answer is final.
 */
export async function invalidAttachments() {
  await Promise.all(state.pendingAttachments.map((e) => e.ready));
  return state.pendingAttachments.filter((e) => e.error);
}

/**
 * Uploads every staged file now that the message is actually being sent --
 * this is the first point any of it is extracted or written to the store.
 * If any upload fails, nothing is sent: the caller aborts and the failed
 * files are put back on the composer.
 *
 * Images take a different path than every other file here: there is no text
 * to extract, so there is nothing for read_document to look up later. They
 * ride straight into the message as base64, the same call that sends the
 * text, instead of going through the documents endpoint first.
 */
// Uploads that succeeded during a send that was then aborted because a sibling
// failed. They're already in the store, so the retry reuses them rather than
// uploading the same file twice.
let carried = { docs: [], images: [] };

export async function commitAttachments(chatId) {
  const staged = state.pendingAttachments;
  state.pendingAttachments = [];
  renderAttachments();
  const docs = [...carried.docs];
  const images = [...carried.images];
  carried = { docs: [], images: [] };
  const failed = [];
  for (const entry of staged) {
    const { file } = entry;
    try {
      if (entry.isImage) {
        await entry.ready;
        if (!entry.normalized) throw new Error(entry.error || 'could not process that image');
        images.push({ filename: file.name, mime: entry.normalized.mime, dataBase64: entry.normalized.data });
        continue;
      }
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
      entry.error = err.message;
      failed.push(entry);
      addError(`attach "${file.name}": ${err.message}`);
    }
  }
  if (failed.length) {
    // Nothing is sent if any attachment failed: the failed ones go back on
    // the composer (flagged) so the user can remove or replace them.
    carried = { docs, images };
    state.pendingAttachments = failed;
    renderAttachments();
    return { docs: [], images: [], failed };
  }
  if (docs.length || images.length) {
    state.chatDocuments.push(...docs);
    // The staged shape carries dataBase64; the artifacts rail reads the same
    // {mime, data} shape everything replayed from the store uses.
    state.chatImages.push(...images.map((i) => ({ filename: i.filename, mime: i.mime, data: i.dataBase64 })));
    renderChatDocs();
  }
  return { docs, images, failed };
}

// The + button opens the composer menu (composer.js); "Attach files" in it
// is what clicks the hidden input now.
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
