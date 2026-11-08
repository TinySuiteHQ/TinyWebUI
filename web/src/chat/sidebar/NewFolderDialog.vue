<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useChats } from '../../stores/chats.ts';
import Modal from '../../ui/Modal.vue';

const emit = defineEmits<{ close: [] }>();
const chats = useChats();
const name = ref('');
const error = ref('');
const saving = ref(false);
const input = ref<HTMLInputElement>();

async function create() {
  saving.value = true;
  error.value = '';
  try {
    await chats.createFolder(name.value);
    emit('close');
  } catch (err) {
    error.value = err.message || 'Could not create folder.';
  } finally {
    saving.value = false;
  }
}

onMounted(() => input.value?.focus());
</script>

<template>
  <Modal id="newFolderDialog" labelledby="newFolderTitle" @close="emit('close')">
    <form id="newFolderForm" @submit.prevent="create">
      <h2 id="newFolderTitle">New folder</h2>
      <label for="newFolderName">name</label>
      <input id="newFolderName" ref="input" v-model="name" maxlength="40" autocomplete="off" placeholder="Folder name">
      <div v-if="error" class="organize-error" role="alert">{{ error }}</div>
      <div class="dialog-actions">
        <button type="button" @click="emit('close')">cancel</button>
        <button type="submit" class="primary" :disabled="saving">create</button>
      </div>
    </form>
  </Modal>
</template>
