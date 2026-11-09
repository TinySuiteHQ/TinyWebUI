/**
 * The file viewer: what is open in it, and the others it can step to. Images
 * and files open here, over the app, instead of in a new tab; anything can
 * open it (the transcript, the artifacts rail, the Files page, an admin's view
 * of a chat), and app/AppShell.vue draws it.
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

/**
 * An image by its URL (a data: URL or /api/images/...); a stored document by
 * id, shown as uploaded where the browser can (a PDF), else as the text the
 * model reads; or text already in hand (an admin's look at a document).
 */
export type ViewItem =
  | { kind: 'image', name: string, src: string }
  | { kind: 'document', name: string, id: string }
  | { kind: 'text', name: string, text: string };

export const useViewer = defineStore('viewer', () => {
  const items = ref<ViewItem[]>([]);
  const index = ref(0);
  const current = computed<ViewItem | null>(() => items.value[index.value] ?? null);

  /** Opens `list` at `at`; the arrows step through the rest of it. */
  function show(list: ViewItem[], at = 0) {
    items.value = list;
    index.value = Math.min(Math.max(at, 0), Math.max(list.length - 1, 0));
  }
  const close = () => { items.value = []; index.value = 0; };
  /** One step back or forward, wrapping at the ends. */
  function step(by: number) {
    const n = items.value.length;
    if (n > 1) index.value = (index.value + by + n) % n;
  }

  return { items, index, current, show, close, step };
});
