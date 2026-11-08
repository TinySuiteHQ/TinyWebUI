/**
 * The sidebar's chat list (server-side, newest first), its folders, and the
 * full-text search that swaps in over it.
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '../core/api.ts';

export type ChatRow = { id: string, title: string, folder?: string | null, updated_at: number, running?: boolean, unread?: boolean };
export type SearchHit = { chatId: string, chatTitle: string, role: string, snippet: string };

export const useChats = defineStore('chats', () => {
  const chats = ref<ChatRow[]>([]);
  const folders = ref<string[]>([]);
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
    if (f.status === 'fulfilled') folders.value = f.value.folders || [];
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

  async function createFolder(name: string) {
    const body = await api.post('/api/folders', { name });
    // A freshly created folder starts open: the point is to move chats into it.
    expanded.value.add(body.folder);
    await load();
  }

  return { chats, folders, expanded, query, results, load, search, clearSearch, markRead, createFolder };
});
