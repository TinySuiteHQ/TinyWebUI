// The uploaded file is kept as-is next to its extracted text, once per distinct
// file (md5), so the rail can open the real thing and an earlier upload can be
// attached to another chat; documents from before that fall back to the text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, ALL_USERS } from '../src/store/index.js';
import { servingFor } from '../src/files/documents.js';

const blobs = (store) => store.db.prepare('SELECT COUNT(*) AS n FROM document_blobs').get().n;

test('the original bytes round-trip and go away with the last document that names them', () => {
  const store = new Store(':memory:');
  const one = store.chats.create({}, ALL_USERS);
  const two = store.chats.create({}, ALL_USERS);
  const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x10]);
  const a = store.documents.add(one.id, { filename: 'a.pdf', content: 'text', original: bytes });
  const b = store.documents.add(two.id, { filename: 'a-again.pdf', content: 'text', original: bytes });
  assert.equal(blobs(store), 1, 'the same bytes are stored once');
  assert.deepEqual(store.documents.original(a.id, ALL_USERS), bytes);
  assert.deepEqual(store.documents.original(b.id, ALL_USERS), bytes);
  assert.equal('data' in store.documents.get(a.id, ALL_USERS), false, 'get() stays light');

  store.documents.delete(a.id, ALL_USERS);
  assert.equal(blobs(store), 1, 'still needed by the other chat');
  store.chats.delete(two.id, ALL_USERS);
  assert.equal(blobs(store), 0);
  store.close();
});

test('a document stored without an original reports none', () => {
  const store = new Store(':memory:');
  const chat = store.chats.create({}, ALL_USERS);
  const doc = store.documents.add(chat.id, { filename: 'old.txt', content: 'text' });
  assert.equal(store.documents.original(doc.id, ALL_USERS), null);
  store.close();
});

test('a file is attached to a chat once', () => {
  const store = new Store(':memory:');
  const chat = store.chats.create({}, ALL_USERS);
  const bytes = Buffer.from('same file');
  const doc = store.documents.add(chat.id, { filename: 'a.txt', content: 'same file', original: bytes });
  assert.equal(store.documents.findInChat(chat.id, bytes).id, doc.id);
  assert.equal(store.documents.findInChat(chat.id, Buffer.from('other')), null);
  store.close();
});

test('the library lists each distinct file once, and only the caller\'s own', () => {
  const store = new Store(':memory:');
  const mine = (title) => store.chats.create({ title }, 'alice');
  const c1 = mine('first'); const c2 = mine('second');
  const bob = store.chats.create({ title: 'bob chat' }, 'bob');
  const bytes = Buffer.from('shared bytes');
  store.documents.add(c1.id, { filename: 'report.txt', content: 'x', original: bytes });
  const latest = store.documents.add(c2.id, { filename: 'report.txt', content: 'x', original: bytes });
  store.documents.add(bob.id, { filename: 'bobs.txt', content: 'y', original: Buffer.from('bob only') });
  store.documents.add(bob.id, { filename: 'report.txt', content: 'x', original: bytes });

  const lib = store.documents.library('alice');
  assert.deepEqual(lib.map((d) => d.id), [latest.id]);
  assert.equal(lib[0].chatTitle, 'second');
  assert.equal(store.documents.library('bob').length, 2);
  store.close();
});

test('copying into another chat shares the file, re-splits the text, and refuses a stranger\'s document', () => {
  const store = new Store(':memory:');
  const from = store.chats.create({}, 'alice');
  const to = store.chats.create({}, 'alice');
  const src = store.documents.add(from.id, { filename: 'a.txt', content: 'hello world', original: Buffer.from('hello world') });

  const copy = store.documents.copyToChat(src.id, to.id, 'alice');
  assert.notEqual(copy.id, src.id);
  assert.equal(store.documents.get(copy.id, 'alice').chat_id, to.id);
  assert.equal(blobs(store), 1);
  assert.equal(store.documents.searchPassages(copy.id, 'hello').length, 1);
  assert.equal(store.documents.copyToChat(src.id, to.id, 'alice').id, copy.id, 'a second copy is the first');

  assert.equal(store.documents.copyToChat(src.id, to.id, 'bob'), null);
  store.close();
});

test('only a PDF or plain text is shown inline; anything a browser would run is not', () => {
  assert.deepEqual(servingFor('x.pdf'), { type: 'application/pdf', inline: true });
  assert.equal(servingFor('x.html').type, 'text/plain; charset=utf-8');
  assert.equal(servingFor('x.svg').inline, false);
  assert.equal(servingFor('x.docx').inline, false);
});

test('a stored message splits back into its text and the document ids its notes name', async () => {
  const { attachmentNote, splitAttachmentNotes } = await import('../public/shared/attachment_note.js');
  const a = { id: 'aa11', filename: 'a "b" (1).pdf', char_len: 1743 };
  const b = { id: 'bb22', filename: 'b.txt', char_len: 12 };
  const stored = 'summarise these' + attachmentNote(a) + attachmentNote(b);
  assert.deepEqual(splitAttachmentNotes(stored), { text: 'summarise these', ids: ['aa11', 'bb22'] });
  assert.deepEqual(splitAttachmentNotes('no notes'), { text: 'no notes', ids: [] });
  // A note-shaped line the user typed mid-message is theirs, not an attachment.
  const typed = `see ${attachmentNote(a)} for context`;
  assert.deepEqual(splitAttachmentNotes(typed), { text: typed, ids: [] });
});
