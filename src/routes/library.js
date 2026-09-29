import { json, readJson } from '../http.js';

/** The sidebar's search, usage statistics, and folders. */
export function libraryRoutes(app) {
  const { store, runs } = app;
  return [
    // Full-text search across every stored message, for the sidebar's search
    // box. GET with a query string, so it is bookmarkable and cacheable like
    // any other read.
    { method: 'GET', path: /^\/api\/search$/, feature: 'search', handle: ({ res, auth, url }) => {
      const q = url.searchParams.get('q') || '';
      const limit = 30;
      // A chat mid-turn is still being written -- store.search would be
      // matching against text that has not settled, and openChat/rejoin is
      // not built to land a click in the middle of a live stream. Overfetch
      // and filter rather than ask the store to know about runs, which is a
      // server-only concept it has no business importing.
      const results = store.search(q, limit * 2, auth.userId)
        .filter((r) => !runs.isRunning(r.chatId))
        .slice(0, limit);
      return json(res, 200, { results });
    } },

    { method: 'GET', path: /^\/api\/usage$/, feature: 'statistics', handle: ({ res, auth }) =>
      json(res, 200, { days: store.usageRollup(auth.userId), statistics: store.usageStatistics(auth.userId) }) },

    { method: 'GET', path: /^\/api\/folders$/, feature: 'folders', handle: ({ res, auth }) =>
      json(res, 200, { folders: store.listFolders(auth.userId) }) },

    { method: 'POST', path: /^\/api\/folders$/, feature: 'folders', handle: async ({ req, res, auth }) => {
      const { name } = await readJson(req);
      const created = store.createFolder(name, auth.userId);
      if (!created) return json(res, 400, { error: 'folder name required' });
      return json(res, 200, { folder: created });
    } },

    { method: 'POST', path: /^\/api\/chats\/([\w.-]+)\/organize$/, feature: 'folders', handle: async ({ req, res, auth, params: [chatId] }) => {
      const { folder, tags } = await readJson(req);
      const found = store.getChat(chatId, auth.userId);
      if (!found) return json(res, 404, { error: 'no such chat' });
      if (folder) store.createFolder(folder, auth.userId);
      const updated = store.organizeChat(chatId, { folder, tags }, auth.userId);
      return json(res, 200, { folder: updated.folder });
    } }
  ];
}
