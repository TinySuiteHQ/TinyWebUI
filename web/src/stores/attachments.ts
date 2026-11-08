/**
 * Attachments: files picked, dropped or pasted are only staged in the page --
 * nothing is uploaded, extracted or written to the store until the message is
 * actually sent. Removing one before then just drops it from the list.
 */
import { defineStore } from 'pinia';
import { reactive, ref } from 'vue';
import { api } from '../core/api.ts';
import { newId } from '../core/id.ts';
import { FEATURE } from '../../../shared/features.ts';
import { useSession } from './session.ts';
import type { Doc, Img } from '../model/turn_model.ts';

export type Staged = {
  key: string,
  file?: File,
  /** A document uploaded in an earlier chat, copied into this one on send. */
  existing?: Doc,
  isImage?: boolean,
  normalized?: { mime: string, data: string } | null,
  error?: string | null,
  ready?: Promise<void>
};

// Some browsers report an empty type for HEIC/AVIF, so a name-based fallback
// keeps those on the image path instead of the text-extraction one.
const IMAGE_EXT = /\.(heic|heif|avif|jpe?g|png|webp|gif)$/i;
const isImageFile = (file: File) => file.type.startsWith('image/') || (!file.type && IMAGE_EXT.test(file.name));

// Mirrors what server/files/documents.ts can extract. The server stays
// authoritative; this only flags an obviously unusable file on its chip and
// blocks sending, instead of finding out after the message went.
const DOC_EXT = new Set([
  '.pdf', '.docx',
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.log',
  '.js', '.ts', '.jsx', '.tsx', '.py', '.rb', '.go', '.rs', '.java', '.c', '.cpp', '.h',
  '.css', '.html', '.xml', '.yaml', '.yml', '.sh', '.sql'
]);
function unsupportedReason(file: File): string | null {
  const i = file.name.lastIndexOf('.');
  const ext = i === -1 ? '' : file.name.slice(i).toLowerCase();
  if (ext === '' || DOC_EXT.has(ext)) return null;
  if (ext === '.doc') return 'legacy .doc is not supported -- save it as .docx or .pdf';
  return `unsupported file type "${ext}"`;
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export const stagedName = (a: Staged) => a.existing?.filename ?? a.file?.name ?? '';

export const useAttachments = defineStore('attachments', () => {
  const pending = ref<Staged[]>([]);
  /** Every document ever attached to the open chat, for the artifacts rail. */
  const chatDocuments = ref<Doc[]>([]);
  /** Every image ever attached to the open chat, derived from its history. */
  const chatImages = ref<Img[]>([]);
  // Uploads that succeeded during a send that was then aborted because a
  // sibling failed. Already in the store, so the retry reuses them.
  let carried: { docs: Doc[], images: Img[] } = { docs: [], images: [] };

  /** A chat switch: nothing staged or carried belongs to the next one. */
  function reset(docs: Doc[] = [], images: Img[] = []) {
    pending.value = [];
    setChatFiles(docs, images);
    carried = { docs: [], images: [] };
  }

  /** What the chat holds, refreshed without touching what is staged. */
  function setChatFiles(docs: Doc[], images: Img[]) {
    chatDocuments.value = docs;
    chatImages.value = images;
  }

  const remove = (a: Staged) => { pending.value = pending.value.filter((x) => x.key !== a.key); };

  /**
   * Queues a file client-side; no network yet, except that an image is
   * normalized at once, so the composer and the optimistic transcript show
   * real, decodable bytes instead of a HEIC/AVIF the browser cannot render.
   * Returns an error to show, if the file cannot go.
   */
  function stage(file: File): string | null {
    const session = useSession();
    const image = isImageFile(file);
    // Dropped and pasted files arrive here too, not only through the + menu.
    if (!session.can(image ? FEATURE.IMAGES : FEATURE.ATTACHMENTS)) {
      return `attach "${file.name}": ${image ? 'images are' : 'attachments are'} turned off for your account`;
    }
    if (image && !session.modelAcceptsImages) return `attach "${file.name}": the current model does not take images`;
    const entry = reactive<Staged>({ key: newId(), file });
    let problem: string | null = null;
    if (image) {
      entry.isImage = true;
      entry.ready = (async () => {
        try {
          const dataBase64 = await toBase64(file);
          entry.normalized = await api.post('/api/images/normalize', { mime: file.type, dataBase64 });
        } catch (err) { entry.error = err.message; }
      })();
    } else {
      entry.error = unsupportedReason(file);
      if (entry.error) problem = `attach "${file.name}": ${entry.error}`;
    }
    pending.value.push(entry);
    return problem;
  }

  /** Queues a document uploaded in an earlier chat; the server copies it in on send. */
  function stageExisting(doc: Doc) {
    if (pending.value.some((e) => e.existing?.id === doc.id)) return;
    pending.value.push({ key: newId(), existing: doc });
  }

  /** Staged entries that cannot be sent, once in-flight image normalizing has settled. */
  async function invalid(): Promise<Staged[]> {
    await Promise.all(pending.value.map((e) => e.ready));
    return pending.value.filter((e) => e.error);
  }

  /**
   * Uploads every staged file now that the message is being sent -- the first
   * point any of it is extracted or stored. If any upload fails, nothing is
   * sent: the failed files go back on the composer, flagged.
   *
   * Images have no text for read_document to look up later, so they ride
   * straight into the message as base64 instead of going through the
   * documents endpoint first.
   */
  async function commit(chatId: string, onError: (text: string) => void) {
    const staged = pending.value;
    pending.value = [];
    const docs = [...carried.docs];
    const images = [...carried.images];
    carried = { docs: [], images: [] };
    const failed: Staged[] = [];
    for (const entry of staged) {
      const name = stagedName(entry);
      try {
        if (entry.existing) {
          const data = await api.post(`/api/chats/${chatId}/documents/attach`, { documentId: entry.existing.id });
          docs.push(data.document);
          continue;
        }
        const file = entry.file as File; // every staged entry is a file or an existing document
        if (entry.isImage) {
          await entry.ready;
          if (!entry.normalized) throw new Error(entry.error || 'could not process that image');
          images.push({ filename: file.name, mime: entry.normalized.mime, dataBase64: entry.normalized.data });
          continue;
        }
        const dataBase64 = await toBase64(file);
        // The chat may not exist yet: the upload route creates it, as /api/chat would.
        const data = await api.post(`/api/chats/${chatId}/documents`, { filename: file.name, mime: file.type, dataBase64 });
        docs.push(data.document);
      } catch (err) {
        entry.error = err.message;
        failed.push(entry);
        onError(`attach "${name}": ${err.message}`);
      }
    }
    if (failed.length) {
      carried = { docs, images };
      pending.value = failed;
      return { docs: [] as Doc[], images: [] as Img[], failed };
    }
    // A file the chat already had comes back as its existing document.
    chatDocuments.value.push(...docs.filter((d) => !chatDocuments.value.some((x) => x.id === d.id)));
    chatImages.value.push(...images.map((i) => ({ filename: i.filename, mime: i.mime, data: i.dataBase64 })));
    return { docs, images, failed };
  }

  return { pending, chatDocuments, chatImages, reset, setChatFiles, remove, stage, stageExisting, invalid, commit };
});
