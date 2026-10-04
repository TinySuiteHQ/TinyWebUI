import { json, readJson } from '../http.js';
import { FEATURE } from '../../public/shared/features.js';

/** The sidebar's search, usage statistics, and folders. */
export function libraryRoutes({ runs, store }) {
  return [
    // Full-text search across every stored message, for the sidebar's search
    // box. GET with a query string, so it is bookmarkable and cacheable like
    // any other read.
    { method: 'GET', path: /^\/api\/search$/, feature: FEATURE.SEARCH, handle: ({ res, auth, url }) => {
      const q = url.searchParams.get('q') || '';
      const limit = 30;
      // A chat mid-turn is still being written -- store.search would be
      // matching against text that has not settled, and openChat/rejoin is
      // not built to land a click in the middle of a live stream. Overfetch
      // and filter rather than ask the store to know about runs, which is a
      // server-only concept it has no business importing.
      const results = store.search.chats(q, limit * 2, auth.userId)
        .filter((r) => !runs.isRunning(r.chatId))
        .slice(0, limit);
      return json(res, 200, { results });
    } },

    // ?model= narrows every figure to one model; adding &provider= to one
    // upstream serving it.
    { method: 'GET', path: /^\/api\/usage$/, feature: FEATURE.STATISTICS, handle: ({ res, auth, url }) => {
      const q = url.searchParams;
      const filter = { model: q.get('model') || undefined, provider: q.has('provider') ? q.get('provider') : undefined };
      return json(res, 200, { days: store.usage.rollup(auth.userId, filter), statistics: store.usage.statistics(auth.userId, filter) });
    } },

    { method: 'GET', path: /^\/api\/folders$/, feature: FEATURE.FOLDERS, handle: ({ res, auth }) =>
      json(res, 200, { folders: store.chats.listFolders(auth.userId) }) },

    { method: 'POST', path: /^\/api\/folders$/, feature: FEATURE.FOLDERS, handle: async ({ req, res, auth }) => {
      const { name } = await readJson(req);
      const created = store.chats.createFolder(name, auth.userId);
      if (!created) return json(res, 400, { error: 'folder name required' });
      return json(res, 200, { folder: created });
    } },

    { method: 'POST', path: /^\/api\/chats\/([\w.-]+)\/organize$/, feature: FEATURE.FOLDERS, handle: async ({ req, res, auth, params: [chatId] }) => {
      const { folder, tags } = await readJson(req);
      const found = store.chats.get(chatId, auth.userId);
      if (!found) return json(res, 404, { error: 'no such chat' });
      if (folder) store.chats.createFolder(folder, auth.userId);
      const updated = store.chats.organize(chatId, { folder, tags }, auth.userId);
      return json(res, 200, { folder: updated.folder });
    } }
  ];
}
