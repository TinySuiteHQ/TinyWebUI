import { json, readJson, UPLOAD_LIMIT } from '../http.ts';
import { extractText, servingFor } from '../files/documents.ts';
import { logger } from '../log.ts';
import { FEATURE } from '../../shared/features.ts';
import { CORPUS } from '../store/index.ts';
import type { Route, RouteDeps } from './types.ts';
import type { SignedIn } from '../access/auth_gate.ts';

const log = logger('retrieval');

const MAX_FILE_BYTES = 5 * 1024 * 1024;

export function documentRoutes({ retrieval, store }: Pick<RouteDeps, 'retrieval' | 'store'>): Route[] {
  // Uploads and attaches land before the first message exists, so the chat is
  // created lazily, the same way /api/chat does for a brand-new conversation.
  // Null when the id is someone else's: "no such chat", never a key clash.
  const chatFor = (chatId: string, auth: SignedIn, title: unknown) => {
    const own = store.chats.get(chatId, auth.userId);
    if (own) return own;
    if (store.chats.byId(chatId)) return null;
    return store.chats.create({ id: chatId, title: String(title).slice(0, 60) }, auth.userId);
  };
  // Embedded once, in the background; a question that arrives first waits for it.
  const ingest = (doc: { id: string }) => retrieval.ingest(CORPUS.DOCUMENTS, doc.id)
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
      const doc = store.documents.add(chat.id, { filename: String(filename), mime: typeof mime === 'string' && mime ? mime : null, content: text, original: buf }, retrieval.passageSettings());
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
      if (!doc!.existing) ingest(doc!);
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
    } }
  ];
}
