<script setup lang="ts">
/** The ⋯ dialog on a chat: move it into a folder, export it, or delete it. */
import { computed, onMounted, ref } from 'vue';
import { api } from '../../core/api.ts';
import { useChats, type ChatRow } from '../../stores/chats.ts';
import { useChat } from '../../stores/chat.ts';
import Modal from '../../ui/Modal.vue';

const props = defineProps<{ chat: ChatRow }>();
const emit = defineEmits<{ close: [] }>();
const chats = useChats();
const current = useChat();

const folder = ref(props.chat.folder || '');
const error = ref('');
const saving = ref(false);
const select = ref<HTMLSelectElement>();

// Chats only move into a folder that already exists (create, then move), plus
// the chat's own folder, in case it was removed from the list since.
const names = computed(() => {
  const own = props.chat.folder || '';
  return own && !chats.folders.includes(own) ? [...chats.folders, own].sort((a, b) => a.localeCompare(b)) : chats.folders;
});

async function save() {
  saving.value = true;
  error.value = '';
  try {
    await api.post(`/api/chats/${props.chat.id}/organize`, { folder: folder.value });
    emit('close');
    await chats.load();
  } catch (err) {
    error.value = err.message || 'Could not save chat organization.';
  } finally {
    saving.value = false;
  }
}

// Not part of Save: a download is done the moment it is asked for.
async function exportAs(format: 'md' | 'json') {
  error.value = '';
  try { await api.download(`/api/chats/${props.chat.id}/export?format=${format}`, format === 'md' ? 'chat.md' : 'chat.tinywebui.json'); }
  catch (err) { error.value = `Could not export chat: ${err.message}`; }
}

async function remove() {
  const id = props.chat.id;
  try { await api.del(`/api/chats/${id}`); } catch (err) { error.value = `Could not delete chat: ${err.message}`; return; }
  emit('close');
  await chats.load();
  if (current.chatId === id) current.newChat();
}

onMounted(() => select.value?.focus());
</script>

<template>
  <Modal id="organizeDialog" labelledby="organizeTitle" icon="chat" title="Chat options" :subtitle="chat.title" @close="emit('close')">
    <form id="organizeForm" class="modal-body" @submit.prevent="save">
      <div class="field">
        <label class="field-label" for="organizeFolder">Folder</label>
        <select id="organizeFolder" ref="select" v-model="folder">
          <option value="">No folder</option>
          <option v-for="n in names" :key="n" :value="n">{{ n }}</option>
        </select>
        <p v-if="folder" class="field-hint">
          {{ chats.prompts[folder] ? 'Its instructions are added to every request here, and' : 'In a folder,' }}
          the model's search of earlier chats looks only at the other chats in it.
        </p>
      </div>
      <div class="field">
        <span class="field-label">Export</span>
        <div class="field-actions">
          <button type="button" @click="exportAs('md')">Markdown</button>
          <button type="button" @click="exportAs('json')">Backup file</button>
        </div>
        <p class="field-hint">Markdown is for reading. A backup file can be imported under Settings, Data. Attached files are not included.</p>
      </div>
      <div v-if="error" class="organize-error" role="alert">{{ error }}</div>
      <div class="dialog-actions">
        <button type="button" class="danger" :aria-label="`Delete “${chat.title}”`" @click="remove">Delete chat</button>
        <button type="button" @click="emit('close')">Cancel</button>
        <button type="submit" class="primary" :disabled="saving">Save</button>
      </div>
    </form>
  </Modal>
</template>
