/**
 * "Attach from earlier chats": a picker over every file the user has already
 * uploaded, so a document used once can be used again without finding the
 * original on disk. Picking only stages it; the copy into this chat is made
 * when the message is sent (see attachments.js).
 */
import { $, el } from '../core/dom.js';
import { api } from '../core/api.js';
import { stageExisting } from './attachments.js';
import { addError } from './transcript.js';

const dialog = $('libraryDialog');
const list = $('libraryList');
const filter = $('libraryFilter');
const confirm = $('libraryAttach');

let docs = [];
const picked = new Set();

const extOf = (name) => (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toUpperCase() : 'FILE');
const when =(ms) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

function render() {
  const q = filter.value.trim().toLowerCase();
  list.innerHTML = '';
  const shown = docs.filter((d) => !q || d.filename.toLowerCase().includes(q));
  if (!shown.length) {
    list.appendChild(Object.assign(el('div', 'empty'), { textContent: docs.length ? 'No file matches.' : 'Nothing uploaded in earlier chats yet.' }));
  }
  for (const d of shown) {
    const row = el('label', 'library-row');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = picked.has(d.id);
    box.onchange = () => { box.checked ? picked.add(d.id) : picked.delete(d.id); sync(); };
    const name = el('span', 'library-name');
    name.textContent = d.filename;
    const type = el('span', 'library-meta');
    type.textContent = extOf(d.filename);
    const date = el('span', 'library-meta');
    date.textContent = when(d.created_at);
    row.append(box, name, type, date);
    list.appendChild(row);
  }
}

function sync() {
  confirm.disabled = picked.size === 0;
  confirm.textContent = picked.size ? `attach ${picked.size}` : 'attach';
}

export async function openLibrary() {
  picked.clear();
  filter.value = '';
  sync();
  list.innerHTML = '';
  list.appendChild(Object.assign(el('div', 'empty'), { textContent: 'Loading…' }));
  dialog.showModal();
  try {
    docs = (await api.get('/api/documents')).documents;
    render();
  } catch (err) {
    dialog.close();
    addError(`could not list earlier files: ${err.message}`);
  }
}

export function initLibrary() {
  filter.addEventListener('input', render);
  $('libraryCancel').addEventListener('click', () => dialog.close());
  $('libraryForm').addEventListener('submit', (e) => {
    e.preventDefault();
    for (const d of docs) if (picked.has(d.id)) stageExisting(d);
    dialog.close();
  });
}
