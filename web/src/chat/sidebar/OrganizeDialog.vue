<script setup lang="ts">
/** The ⋯ dialog on a chat: move it into a folder, or delete it. */
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
  <Modal id="organizeDialog" labelledby="organizeTitle" @close="emit('close')">
    <form id="organizeForm" @submit.prevent="save">
      <h2 id="organizeTitle">Chat options</h2>
      <label for="organizeFolder">folder</label>
      <select id="organizeFolder" ref="select" v-model="folder">
        <option value="">(no folder)</option>
        <option v-for="n in names" :key="n" :value="n">{{ n }}</option>
      </select>
      <div v-if="error" class="organize-error" role="alert">{{ error }}</div>
      <div class="dialog-actions">
        <button type="button" class="danger" :aria-label="`Delete “${chat.title}”`" @click="remove">delete chat</button>
        <button type="button" @click="emit('close')">cancel</button>
        <button type="submit" class="primary" :disabled="saving">save</button>
      </div>
    </form>
  </Modal>
</template>
