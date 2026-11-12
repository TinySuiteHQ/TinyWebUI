<script setup lang="ts">
/**
 * "Attach from earlier chats": a picker over every file already sent, so one
 * used once can be used again without finding it on disk. Documents and
 * images are kept differently, so they come back differently: a document is
 * stored once with its text and is copied into this chat when the message is
 * sent; an image lives on the message that sent it, so picking one fetches
 * its bytes and stages them as a new attachment (as Files does).
 */
import { computed, onMounted, ref } from 'vue';
import { api } from '../../core/api.ts';
import { FEATURE } from '../../../../shared/features.ts';
import { useAttachments, type Lane } from '../../stores/attachments.ts';
import { useChat } from '../../stores/chat.ts';
import { useSession } from '../../stores/session.ts';
import type { Doc } from '../../model/turn_model.ts';
import Modal from '../../ui/Modal.vue';

type DocRow = Doc & { created_at: number };
type ImageRow = { messageId: number, index: number, chatTitle: string, filename: string | null, mime: string, created_at: number | null };
type Row = { key: string, name: string, type: string, created_at: number | null, blocked: string, attach: () => Promise<string | null> | string | null };

const props = withDefaults(defineProps<{ lane?: Lane }>(), { lane: 'compose' });
const emit = defineEmits<{ close: [] }>();
const attachments = useAttachments();
const chat = useChat();
const session = useSession();

const rows = ref<Row[] | null>(null);
const filter = ref('');
const picked = ref(new Set<string>());
const busy = ref(false);

const extOf = (name: string) => (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toUpperCase() : 'FILE');
const when = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const shown = computed(() => {
  const q = filter.value.trim().toLowerCase();
  return (rows.value || []).filter((r) => !q || r.name.toLowerCase().includes(q));
});

function docRow(d: DocRow): Row {
  return {
    key: `d:${d.id}`, name: d.filename, type: extOf(d.filename), created_at: d.created_at, blocked: '',
    attach: () => { attachments.stageExisting(d, props.lane); return null; }
  };
}
function imageRow(i: ImageRow): Row {
  // Images sent before names were kept go by the chat they were sent in.
  const name = i.filename || i.chatTitle;
  return {
    key: `i:${i.messageId}:${i.index}`, name, type: 'Image', created_at: i.created_at,
    blocked: session.modelAcceptsImages ? '' : 'The current model does not take images',
    attach: async () => {
      const blob = await api.blob(`/api/images/${i.messageId}/${i.index}`);
      return attachments.stage(new File([blob], i.filename || `image.${i.mime.split('/')[1] || 'png'}`, { type: i.mime }), props.lane);
    }
  };
}

function toggle(key: string, on: boolean) { if (on) picked.value.add(key); else picked.value.delete(key); }
async function attach() {
  busy.value = true;
  for (const r of rows.value || []) {
    if (!picked.value.has(r.key)) continue;
    try {
      const problem = await r.attach();
      if (problem) chat.addError(problem);
    } catch (err) {
      chat.addError(`could not attach ${r.name}: ${err.message}`);
    }
  }
  busy.value = false;
  emit('close');
}

onMounted(async () => {
  const [d, i] = await Promise.allSettled([
    session.can(FEATURE.ATTACHMENTS) ? api.get('/api/documents') : Promise.resolve({ documents: [] }),
    session.can(FEATURE.IMAGES) ? api.get('/api/images') : Promise.resolve({ images: [] })
  ]);
  if (d.status === 'rejected' && i.status === 'rejected') {
    emit('close');
    chat.addError(`could not list earlier files: ${d.reason?.message || d.reason}`);
    return;
  }
  const list = [
    ...(d.status === 'fulfilled' ? (d.value.documents as DocRow[]).map(docRow) : []),
    ...(i.status === 'fulfilled' ? (i.value.images as ImageRow[]).map(imageRow) : [])
  ];
  rows.value = list.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
});
</script>

<template>
  <Modal id="libraryDialog" labelledby="libraryTitle" @close="emit('close')">
    <form id="libraryForm" @submit.prevent="attach">
      <h2 id="libraryTitle">Attach from earlier chats</h2>
      <input v-model="filter" type="search" autocomplete="off" placeholder="Filter by file name" aria-label="Filter files">
      <div class="library-list">
        <div v-if="rows === null" class="empty">Loading…</div>
        <div v-else-if="!shown.length" class="empty">{{ rows.length ? 'No file matches.' : 'Nothing sent in earlier chats yet.' }}</div>
        <label v-for="r in shown" :key="r.key" class="library-row" :class="{ off: r.blocked }" :title="r.blocked || undefined">
          <input type="checkbox" :checked="picked.has(r.key)" :disabled="!!r.blocked" @change="toggle(r.key, ($event.target as HTMLInputElement).checked)">
          <span class="library-name">{{ r.name }}</span>
          <span class="library-meta">{{ r.type }}</span>
          <span class="library-meta">{{ when(r.created_at) }}</span>
        </label>
      </div>
      <div class="dialog-actions">
        <button type="button" @click="emit('close')">Cancel</button>
        <button type="submit" class="primary" :disabled="!picked.size || busy">{{ picked.size ? `Attach ${picked.size}` : 'Attach' }}</button>
      </div>
    </form>
  </Modal>
</template>
