<script setup lang="ts">
/**
 * Images and files, opened over the app rather than in a new tab. An image
 * shows full size; a PDF in the browser's own viewer, framed; Markdown
 * rendered; anything else as the text extracted from it (what the model
 * reads), with the original a Download away. Arrow keys step through the
 * other files it was opened with.
 */
import { computed, ref, watch } from 'vue';
import { api } from '../../core/api.ts';
import { useViewer } from '../../stores/viewer.ts';
import Icon from '../../ui/Icon.vue';
import Modal from '../../ui/Modal.vue';
import Markdown from '../Markdown.vue';

const viewer = useViewer();
const item = computed(() => viewer.current!);
const ext = computed(() => /\.[^.]+$/.exec(item.value.name.toLowerCase())?.[0] ?? '');

/** How the current item is drawn. */
const mode = computed<'image' | 'pdf' | 'markdown' | 'text'>(() => {
  const it = item.value;
  if (it.kind === 'image') return 'image';
  if (it.kind === 'document' && ext.value === '.pdf') return 'pdf';
  return ext.value === '.md' || ext.value === '.markdown' ? 'markdown' : 'text';
});
// Formats whose text is the file itself; for the rest (Word, Excel, ...) it is what was extracted from it.
const PLAIN = new Set(['', '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.log', '.xml', '.yaml', '.yml', '.html', '.htm']);
const extracted = computed(() => item.value.kind === 'document' && mode.value === 'text' && !PLAIN.has(ext.value));

const original = computed(() => (item.value.kind === 'document' ? `/api/documents/${encodeURIComponent(item.value.id)}/original` : ''));
const download = computed(() => (item.value.kind === 'image' ? item.value.src : original.value));

// A document's text is fetched when it is the one shown, and only then.
const text = ref('');
const error = ref('');
const loading = ref(false);
let request = 0;
watch(item, async (it) => {
  error.value = '';
  text.value = it.kind === 'text' ? it.text : '';
  if (it.kind !== 'document' || mode.value === 'pdf') return;
  const mine = ++request;
  loading.value = true;
  try {
    const doc = await api.get(`/api/documents/${encodeURIComponent(it.id)}`);
    if (mine === request) text.value = String(doc.content ?? '');
  } catch (err) {
    if (mine === request) error.value = `Couldn't open ${it.name}: ${err.message}`;
  } finally {
    if (mine === request) loading.value = false;
  }
}, { immediate: true });

function onKey(e: KeyboardEvent) {
  if (e.key === 'ArrowLeft') { e.preventDefault(); viewer.step(-1); }
  if (e.key === 'ArrowRight') { e.preventDefault(); viewer.step(1); }
}
</script>

<template>
  <Modal labelledby="viewerTitle" class="viewer" @close="viewer.close()">
    <div class="viewer-frame" tabindex="-1" @keydown="onKey">
      <header class="viewer-head">
        <Icon :name="item.kind === 'image' ? 'image' : 'doc'" />
        <h2 id="viewerTitle" :title="item.name">{{ item.name }}</h2>
        <span v-if="viewer.items.length > 1" class="viewer-count">{{ viewer.index + 1 }} of {{ viewer.items.length }}</span>
        <a v-if="download" class="btn viewer-download" :href="download" :download="item.name">Download</a>
        <button type="button" class="icon-btn" aria-label="Close" title="Close (Esc)" @click="viewer.close()"><Icon name="x" /></button>
      </header>
      <div class="viewer-body" :class="`is-${mode}`">
        <img v-if="mode === 'image' && item.kind === 'image'" :src="item.src" :alt="item.name">
        <iframe v-else-if="mode === 'pdf'" :src="original" :title="item.name" />
        <p v-else-if="error" class="viewer-msg" role="alert">{{ error }}</p>
        <p v-else-if="loading" class="viewer-msg">Loading…</p>
        <template v-else>
          <p v-if="extracted" class="viewer-note">The text taken from this file, as the model reads it. Download it to see it as it was.</p>
          <div v-if="mode === 'markdown'" class="viewer-doc"><Markdown :text="text" /></div>
          <pre v-else class="viewer-text">{{ text }}</pre>
        </template>
      </div>
      <template v-if="viewer.items.length > 1">
        <button type="button" class="viewer-nav prev" aria-label="Previous file" title="Previous (←)" @click="viewer.step(-1)">‹</button>
        <button type="button" class="viewer-nav next" aria-label="Next file" title="Next (→)" @click="viewer.step(1)">›</button>
      </template>
    </div>
  </Modal>
</template>
