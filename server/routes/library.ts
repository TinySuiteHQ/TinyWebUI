import { json, readJson } from '../http.ts';
import { FEATURE } from '../../shared/features.ts';
import type { SearchHitView } from '../../shared/api.ts';
import type { Route, RouteDeps } from './types.ts';

/** The sidebar's search, usage statistics, and folders. */
export function libraryRoutes({ runs, store }: Pick<RouteDeps, 'runs' | 'store'>): Route[] {
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
      return json(res, 200, { results: results satisfies SearchHitView[] });
    } },

    // ?model= narrows every figure to one model; adding &provider= to one
    // upstream serving it.
    { method: 'GET', path: /^\/api\/usage$/, feature: FEATURE.STATISTICS, handle: ({ res, auth, url }) => {
      const q = url.searchParams;
      const filter = { model: q.get('model') || undefined, provider: q.has('provider') ? q.get('provider') : undefined };
      return json(res, 200, { days: store.usage.rollup(auth.userId, filter), statistics: store.usage.statistics(auth.userId, filter) });
    } },

    // Names stay a plain list (what moving a chat picks from); the folders
    // with instructions of their own come alongside, by name.
    { method: 'GET', path: /^\/api\/folders$/, feature: FEATURE.FOLDERS, handle: ({ res, auth }) =>
      json(res, 200, { folders: store.chats.listFolders(auth.userId), prompts: store.chats.folderPrompts(auth.userId) }) },

    { method: 'POST', path: /^\/api\/folders$/, feature: FEATURE.FOLDERS, handle: async ({ req, res, auth }) => {
      const { name, prompt } = await readJson(req);
      if (prompt !== undefined && typeof prompt !== 'string') return json(res, 400, { error: 'prompt must be text' });
      const created = store.chats.createFolder(name, auth.userId);
      if (!created) return json(res, 400, { error: 'folder name required' });
      if (prompt) store.chats.updateFolder(created, { prompt }, auth.userId);
      return json(res, 200, { folder: created });
    } },

    // Rename a folder (its chats move with it) and/or set its instructions.
    // The name goes in the body: a folder name may hold any character.
    { method: 'PATCH', path: /^\/api\/folders$/, feature: FEATURE.FOLDERS, handle: async ({ req, res, auth }) => {
      const { name, rename, prompt } = await readJson(req);
      if (typeof name !== 'string' || !name.trim()) return json(res, 400, { error: 'folder name required' });
      if (rename !== undefined && (typeof rename !== 'string' || !rename.trim())) return json(res, 400, { error: 'the new name cannot be blank' });
      if (prompt !== undefined && typeof prompt !== 'string') return json(res, 400, { error: 'prompt must be text' });
      const done = store.chats.updateFolder(name, { rename, prompt }, auth.userId);
      if (done === 'missing') return json(res, 404, { error: 'no such folder' });
      if (done === 'taken') return json(res, 409, { error: 'there is already a folder with that name' });
      return json(res, 200, { folder: done });
    } },

    // Which chats a folder holds, set in one go from its dialog: listed chats
    // join it, any it held that are not listed leave it for no folder.
    { method: 'PATCH', path: /^\/api\/folders\/chats$/, feature: FEATURE.FOLDERS, handle: async ({ req, res, auth }) => {
      const { name, chatIds } = await readJson(req);
      if (typeof name !== 'string' || !name.trim()) return json(res, 400, { error: 'folder name required' });
      if (!Array.isArray(chatIds) || !chatIds.every((id) => typeof id === 'string')) return json(res, 400, { error: 'chatIds must be a list of chat ids' });
      const moved = store.chats.setFolderChats(name, chatIds, auth.userId);
      if (moved === 'missing') return json(res, 404, { error: 'no such folder' });
      return json(res, 200, { folder: name, chats: moved });
    } },

    { method: 'POST', path: /^\/api\/chats\/([\w.-]+)\/organize$/, feature: FEATURE.FOLDERS, handle: async ({ req, res, auth, params: [chatId] }) => {
      const { folder, tags } = await readJson(req);
      const found = store.chats.get(chatId, auth.userId);
      if (!found) return json(res, 404, { error: 'no such chat' });
      if (folder) store.chats.createFolder(folder, auth.userId);
      const updated = store.chats.organize(chatId, { folder, tags }, auth.userId);
      return json(res, 200, { folder: updated!.folder });
    } }
  ];
}
