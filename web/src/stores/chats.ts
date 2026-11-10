/**
 * The sidebar's chat list (server-side, newest first), its folders, and the
 * full-text search that swaps in over it.
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '../core/api.ts';
import type { SearchHitView } from '../../../shared/api.ts';

export type ChatRow = {
  id: string, title: string, folder?: string | null, updated_at: number, running?: boolean, unread?: boolean,
  /** A fork: the chat it was branched from; the sidebar lists it under that one. */
  parent_id?: string | null
};
export type SearchHit = SearchHitView;

export const useChats = defineStore('chats', () => {
  const chats = ref<ChatRow[]>([]);
  const folders = ref<string[]>([]);
  /** The folders with instructions of their own: name -> prompt. */
  const prompts = ref<Record<string, string>>({});
  // Folders start collapsed; the ones opened stay open across redraws.
  const expanded = ref(new Set<string>());

  const query = ref('');
  const results = ref<SearchHit[] | null>(null);
  let requestSeq = 0;
  let searchSeq = 0;
  let debounce: ReturnType<typeof setTimeout> | undefined;

  async function load() {
    // Many callers (polls, stream ends, edits) overlap; only the newest call
    // may write, or an older list could land last and drop a just-made chat.
    const request = ++requestSeq;
    const [c, f] = await Promise.allSettled([api.get('/api/chats'), api.get('/api/folders')]);
    if (request !== requestSeq) return;
    // On failure keep whatever is already on screen rather than blanking it.
    if (c.status === 'fulfilled') chats.value = c.value.chats || [];
    if (f.status === 'fulfilled') { folders.value = f.value.folders || []; prompts.value = f.value.prompts || {}; }
  }

  /** Debounced: each keystroke would otherwise be a round trip. */
  function search(q: string) {
    query.value = q;
    clearTimeout(debounce);
    debounce = setTimeout(() => run(q), 150);
  }

  async function run(q: string) {
    const seq = ++searchSeq;
    if (!q.trim()) { results.value = null; return; }
    let hits: SearchHit[] = [];
    try { hits = (await api.get(`/api/search?q=${encodeURIComponent(q)}`)).results || []; } catch { /* the next keystroke retries */ }
    if (seq !== searchSeq) return; // a newer query landed first
    results.value = hits;
  }

  function clearSearch() {
    clearTimeout(debounce);
    searchSeq++; // a slow reply must not land after this
    query.value = '';
    results.value = null;
  }

  /** Clears an automation's unread mark; shown cleared at once, the next load agrees. */
  async function markRead(id: string) {
    const row = chats.value.find((c) => c.id === id);
    if (row) row.unread = false;
    try { await api.post(`/api/chats/${encodeURIComponent(id)}/read`); } catch { /* still marked; the next look retries */ }
  }

  /** Creates a folder; returns its name as stored (trimmed, maybe shortened). */
  async function createFolder(name: string, prompt = ''): Promise<string> {
    const body = await api.post('/api/folders', { name, prompt });
    // A freshly created folder starts open, so the chats put in it are in view.
    expanded.value.add(body.folder);
    await load();
    return body.folder;
  }

  /** Makes these the folder's chats: listed ones join, the rest of its chats leave it. */
  async function setFolderChats(name: string, chatIds: string[]) {
    await api.patch('/api/folders/chats', { name, chatIds });
    await load();
  }

  async function renameChat(id: string, title: string): Promise<string> {
    const body = await api.patch(`/api/chats/${id}`, { title });
    const row = chats.value.find((c) => c.id === id);
    if (row) row.title = body.title;
    return body.title;
  }

  /** Renames a folder (its chats move with it) and sets its instructions. */
  async function saveFolder(name: string, { rename, prompt }: { rename: string, prompt: string }) {
    const body = await api.patch('/api/folders', { name, rename, prompt });
    if (body.folder !== name && expanded.value.delete(name)) expanded.value.add(body.folder);
    await load();
  }

  return { chats, folders, prompts, expanded, saveFolder, query, results, load, search, clearSearch, markRead, createFolder, setFolderChats, renameChat };
});
