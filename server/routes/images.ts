import { json, readJson, UPLOAD_LIMIT } from '../http.ts';
import { isWireMime, normalizeUpload } from '../files/images.ts';
import { FEATURE } from '../../shared/features.ts';
import type { Route, RouteDeps } from './types.ts';

/**
 * Images, kept apart from documents: an image has no text to extract or
 * search, so it rides on the message that attached it (messages.images_json)
 * rather than becoming a document of its own.
 */
export function imageRoutes({ store }: Pick<RouteDeps, 'store'>): Route[] {
  return [
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
    } },

    // Every image the user attached, for the Files page; the bytes come one at a time below.
    { method: 'GET', path: /^\/api\/images$/, feature: FEATURE.IMAGES, handle: ({ res, auth }) =>
      json(res, 200, { images: store.messages.imageLibrary(auth.userId) }) },

    { method: 'GET', path: /^\/api\/images\/(\d+)\/(\d+)$/, feature: FEATURE.IMAGES, handle: ({ res, auth, params: [messageId, index] }) => {
      const img = store.messages.image(Number(messageId), Number(index), auth.userId);
      if (!img || !isWireMime(img.mime)) return json(res, 404, { error: 'no such image' });
      // A stored image never changes, so the browser may keep it.
      res.writeHead(200, { 'content-type': img.mime, 'content-length': img.data.length, 'cache-control': 'private, max-age=86400' });
      res.end(img.data);
    } }
  ];
}
