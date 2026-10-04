import { json, readJson, UPLOAD_LIMIT } from '../http.js';
import { extractText, servingFor } from '../files/documents.js';
import { normalizeImage } from '../files/images.js';
import { logger } from '../log.js';
import { FEATURE } from '../../public/shared/features.js';
import { CORPUS } from '../store/index.js';

const log = logger('retrieval');

const MAX_FILE_BYTES = 5 * 1024 * 1024;

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

export function documentRoutes({ retrieval, store }) {
  // Uploads and attaches land before the first message exists, so the chat is
  // created lazily, the same way /api/chat does for a brand-new conversation.
  // Null when the id is someone else's: "no such chat", never a key clash.
  const chatFor = (chatId, auth, title) => {
    const own = store.chats.get(chatId, auth.userId);
    if (own) return own;
    if (store.chats.byId(chatId)) return null;
    return store.chats.create({ id: chatId, title: String(title).slice(0, 60) }, auth.userId);
  };
  // Embedded once, in the background; a question that arrives first waits for it.
  const ingest = (doc) => retrieval.ingest(CORPUS.DOCUMENTS, doc.id)
    .catch((err) => log.error(`embedding ${doc.id} failed: ${err.message}`));

  return [
    // Uploads, including the paste-as-file path.
    { method: 'POST', path: /^\/api\/chats\/([\w.-]+)\/documents$/, feature: FEATURE.ATTACHMENTS, handle: async ({ req, res, auth, params: [chatId] }) => {
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

      const chat = chatFor(chatId, auth, filename);
      if (!chat) return json(res, 404, { error: 'no such chat' });
      // The same file dropped in twice is one document in the chat.
      const already = store.documents.findInChat(chat.id, buf);
      if (already) return json(res, 200, { chatId: chat.id, document: already });
      const doc = store.documents.add(chat.id, { filename: String(filename), mime: mime || null, content: text, original: buf }, retrieval.passageSettings());
      ingest(doc);
      return json(res, 200, { chatId: chat.id, document: doc });
    } },

    // What the user has attached in earlier chats, one line per distinct file,
    // for the "attach from earlier chats" picker.
    { method: 'GET', path: /^\/api\/documents$/, feature: FEATURE.ATTACHMENTS, handle: ({ res, auth }) => {
      return json(res, 200, { documents: store.documents.library(auth.userId) });
    } },

    // Attaches a file the user already uploaded elsewhere, without uploading
    // it again: the chat gets its own copy of the text (same stored file).
    { method: 'POST', path: /^\/api\/chats\/([\w.-]+)\/documents\/attach$/, feature: FEATURE.ATTACHMENTS, handle: async ({ req, res, auth, params: [chatId] }) => {
      const { documentId } = await readJson(req);
      if (typeof documentId !== 'string' || !documentId) return json(res, 400, { error: 'documentId is required' });
      // Checked before the chat is created, so a bad id leaves no empty chat behind.
      const source = store.documents.get(documentId, auth.userId);
      if (!source) return json(res, 404, { error: 'no such document' });
      const chat = chatFor(chatId, auth, source.filename);
      if (!chat) return json(res, 404, { error: 'no such chat' });
      const doc = store.documents.copyToChat(documentId, chat.id, auth.userId, retrieval.passageSettings());
      if (!doc.existing) ingest(doc);
      return json(res, 200, { chatId: chat.id, document: doc });
    } },

    // Lets the "files" rail open a document's full extracted text -- the
    // same content the model reads via read_document, in a plain new tab.
    // Documents have no delete route of their own: the only way one goes
    // away is editing the message that attached it (see /edit in chats.js).
    { method: 'GET', path: /^\/api\/documents\/([\w.-]+)$/, feature: FEATURE.ATTACHMENTS, handle: ({ res, auth, params: [id] }) => {
      const doc = store.documents.get(id, auth.userId);
      if (!doc) return json(res, 404, { error: 'no such document' });
      return json(res, 200, { filename: doc.filename, mime: doc.mime, content: doc.content });
    } },

    // What the "artifacts" rail opens: the file as uploaded. Documents stored
    // before originals were kept fall back to their extracted text.
    { method: 'GET', path: /^\/api\/documents\/([\w.-]+)\/original$/, feature: FEATURE.ATTACHMENTS, handle: ({ res, auth, params: [id] }) => {
      const doc = store.documents.get(id, auth.userId);
      if (!doc) return json(res, 404, { error: 'no such document' });
      const original = store.documents.original(id, auth.userId);
      const { type, inline } = original ? servingFor(doc.filename) : servingFor('.txt');
      const body = original || Buffer.from(doc.content, 'utf8');
      // The name is percent-encoded (RFC 5987) so it cannot break out of the header.
      const disposition = `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(doc.filename)}`;
      res.writeHead(200, { 'content-type': type, 'content-length': body.length, 'content-disposition': disposition });
      res.end(body);
    } },

    // Converts one staged image to a wire-safe format before it's ever sent,
    // so the composer's own preview and the optimistic thumbnail in the
    // transcript show the same bytes the model (and the store) end up with,
    // instead of a HEIC/AVIF the browser can't decode until the turn ends
    // and the chat reloads with what the server stored.
    { method: 'POST', path: /^\/api\/images\/normalize$/, feature: FEATURE.IMAGES, handle: async ({ req, res }) => {
      const { mime, dataBase64 } = await readJson(req, UPLOAD_LIMIT);
      const normalized = await normalizeUpload(mime, dataBase64);
      if (!normalized) return json(res, 400, { error: 'unrecognized or oversized image' });
      return json(res, 200, normalized);
    } }
  ];
}
