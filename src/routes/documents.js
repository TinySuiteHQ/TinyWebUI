import { json, readJson, UPLOAD_LIMIT } from '../http.js';
import { extractText } from '../files/documents.js';
import { normalizeImage } from '../files/images.js';

const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** The inline note that tells the model an id it can read_document on. */
export function attachmentNote(doc) {
  return `\n\n[Attached document: "${doc.filename}" (id: ${doc.id}, ${doc.char_len.toLocaleString('en-US')} chars). Use read_document to search or read it.]`;
}

/** Decodes and normalizes one uploaded image; null on anything unusable. */
export async function normalizeUpload(mimeRaw, dataBase64) {
  const mime = String(mimeRaw || '');
  if (!mime.startsWith('image/') && mime !== '') return null;
  let buf;
  try { buf = Buffer.from(String(dataBase64 || ''), 'base64'); } catch { return null; }
  if (!buf.length || buf.length > MAX_FILE_BYTES) return null;
  try {
    const normalized = await normalizeImage(buf, mime);
    return normalized && { mime: normalized.mime, data: normalized.data.toString('base64') };
  } catch {
    return null;
  }
}

export function documentRoutes(app) {
  const { store, retrieval } = app;
  return [
    // Uploads (including the paste-as-file path) land here before the first
    // message exists, so the chat is created lazily, the same way /api/chat
    // creates one for a brand-new conversation.
    { method: 'POST', path: /^\/api\/chats\/([\w.-]+)\/documents$/, feature: 'attachments', handle: async ({ req, res, auth, params: [chatId] }) => {
      const { filename, mime, dataBase64 } = await readJson(req, UPLOAD_LIMIT);
      if (!filename || typeof dataBase64 !== 'string') {
        return json(res, 400, { error: 'filename and dataBase64 are required' });
      }
      let buf;
      try {
        buf = Buffer.from(dataBase64, 'base64');
      } catch {
        return json(res, 400, { error: 'dataBase64 is not valid base64' });
      }
      if (buf.length > MAX_FILE_BYTES) {
        return json(res, 400, { error: `file exceeds ${MAX_FILE_BYTES.toLocaleString('en-US')} byte limit` });
      }

      let text;
      try {
        text = await extractText(buf, String(filename));
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
      if (!text.trim()) return json(res, 400, { error: 'no extractable text in that file' });

      if (!store.chats.get(chatId, auth.userId) && store.chats.byId(chatId)) return json(res, 404, { error: 'no such chat' });
      const chat = store.chats.get(chatId, auth.userId) || store.chats.create({ id: chatId, title: String(filename).slice(0, 60) }, auth.userId);
      const doc = store.documents.add(chat.id, { filename: String(filename), mime: mime || null, content: text }, retrieval.passageSettings());
      // Embedded once, in the background; a question that arrives first waits for it.
      retrieval.ingest('documents', doc.id).catch((err) => console.error(`[tinywebui] embedding ${doc.id} failed: ${err.message}`));
      return json(res, 200, { chatId: chat.id, document: doc });
    } },

    // Lets the "files" rail open a document's full extracted text -- the
    // same content the model reads via read_document, in a plain new tab.
    // Documents have no delete route of their own: the only way one goes
    // away is editing the message that attached it (see /edit in chats.js).
    { method: 'GET', path: /^\/api\/documents\/([\w.-]+)$/, feature: 'attachments', handle: ({ res, auth, params: [id] }) => {
      const doc = store.documents.get(id, auth.userId);
      if (!doc) return json(res, 404, { error: 'no such document' });
      return json(res, 200, { filename: doc.filename, mime: doc.mime, content: doc.content });
    } },

    // Converts one staged image to a wire-safe format before it's ever sent,
    // so the composer's own preview and the optimistic thumbnail in the
    // transcript show the same bytes the model (and the store) end up with,
    // instead of a HEIC/AVIF the browser can't decode until the turn ends
    // and the chat reloads with what the server stored.
    { method: 'POST', path: /^\/api\/images\/normalize$/, feature: 'images', handle: async ({ req, res }) => {
      const { mime, dataBase64 } = await readJson(req, UPLOAD_LIMIT);
      const normalized = await normalizeUpload(mime, dataBase64);
      if (!normalized) return json(res, 400, { error: 'unrecognized or oversized image' });
      return json(res, 200, normalized);
    } }
  ];
}
