<script setup lang="ts">
/**
 * "Attach from earlier chats": a picker over every file already uploaded, so
 * a document used once can be used again without finding it on disk. Picking
 * only stages it; the copy into this chat is made when the message is sent.
 */
import { computed, onMounted, ref } from 'vue';
import { api } from '../../core/api.ts';
import { useAttachments } from '../../stores/attachments.ts';
import { useChat } from '../../stores/chat.ts';
import type { Doc } from '../../model/turn_model.ts';
import Modal from '../../ui/Modal.vue';

const emit = defineEmits<{ close: [] }>();
const attachments = useAttachments();
const chat = useChat();

const docs = ref<(Doc & { created_at: number })[] | null>(null);
const filter = ref('');
const picked = ref(new Set<string>());

const extOf = (name: string) => (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toUpperCase() : 'FILE');
const when = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const shown = computed(() => {
  const q = filter.value.trim().toLowerCase();
  return (docs.value || []).filter((d) => !q || d.filename.toLowerCase().includes(q));
});

function toggle(id: string, on: boolean) { if (on) picked.value.add(id); else picked.value.delete(id); }
function attach() {
  for (const d of docs.value || []) if (picked.value.has(d.id)) attachments.stageExisting(d);
  emit('close');
}

onMounted(async () => {
  try { docs.value = (await api.get('/api/documents')).documents; } catch (err) {
    emit('close');
    chat.addError(`could not list earlier files: ${err.message}`);
  }
});
</script>

<template>
  <Modal id="libraryDialog" labelledby="libraryTitle" @close="emit('close')">
    <form id="libraryForm" @submit.prevent="attach">
      <h2 id="libraryTitle">Attach from earlier chats</h2>
      <input v-model="filter" type="search" autocomplete="off" placeholder="Filter by file name" aria-label="Filter files">
      <div class="library-list">
        <div v-if="docs === null" class="empty">Loading…</div>
        <div v-else-if="!shown.length" class="empty">{{ docs.length ? 'No file matches.' : 'Nothing uploaded in earlier chats yet.' }}</div>
        <label v-for="d in shown" :key="d.id" class="library-row">
          <input type="checkbox" :checked="picked.has(d.id)" @change="toggle(d.id, ($event.target as HTMLInputElement).checked)">
          <span class="library-name">{{ d.filename }}</span>
          <span class="library-meta">{{ extOf(d.filename) }}</span>
          <span class="library-meta">{{ when(d.created_at) }}</span>
        </label>
      </div>
      <div class="dialog-actions">
        <button type="button" @click="emit('close')">cancel</button>
        <button type="submit" class="primary" :disabled="!picked.size">{{ picked.size ? `attach ${picked.size}` : 'attach' }}</button>
      </div>
    </form>
  </Modal>
</template>
