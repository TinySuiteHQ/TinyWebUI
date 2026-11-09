<script setup lang="ts">
/**
 * A folder, new or existing: its name and its own instructions. The
 * instructions go into every turn of the chats in it, after the system
 * prompt and the person's own; and a chat in a folder searches only the
 * other chats in that folder (search_chats), so both are said here.
 */
import { computed, onMounted, ref } from 'vue';
import { useChats } from '../../stores/chats.ts';
import Modal from '../../ui/Modal.vue';

const props = defineProps<{ folder?: string | null, count?: number }>();
const emit = defineEmits<{ close: [] }>();
const chats = useChats();

const editing = computed(() => Boolean(props.folder));
const name = ref(props.folder || '');
const prompt = ref(props.folder ? chats.prompts[props.folder] || '' : '');
const error = ref('');
const saving = ref(false);
const input = ref<HTMLInputElement>();

const subtitle = computed(() => {
  if (!editing.value) return 'Group related chats, and give them instructions of their own.';
  const n = props.count ?? 0;
  return `${n} chat${n === 1 ? '' : 's'} in it`;
});
const unchanged = computed(() => editing.value && name.value.trim() === props.folder && prompt.value.trim() === (chats.prompts[props.folder || ''] || ''));

async function save() {
  if (!name.value.trim()) { error.value = 'Give the folder a name.'; input.value?.focus(); return; }
  if (unchanged.value) { emit('close'); return; }
  saving.value = true;
  error.value = '';
  try {
    if (props.folder) await chats.saveFolder(props.folder, { rename: name.value.trim(), prompt: prompt.value });
    else await chats.createFolder(name.value.trim(), prompt.value);
    emit('close');
  } catch (err) {
    error.value = err.message || 'Could not save the folder.';
  } finally {
    saving.value = false;
  }
}

onMounted(() => input.value?.focus());
</script>

<template>
  <Modal :id="editing ? 'folderDialog' : 'newFolderDialog'" labelledby="folderDialogTitle" icon="folderPlus"
         :title="editing ? 'Folder settings' : 'New folder'" :subtitle="subtitle" @close="emit('close')">
    <form id="folderForm" class="modal-body" @submit.prevent="save">
      <div class="field">
        <label class="field-label" for="folderName">Name</label>
        <input id="folderName" ref="input" v-model="name" maxlength="40" autocomplete="off" placeholder="e.g. Thesis, Client work">
      </div>
      <div class="field">
        <label class="field-label" for="folderPrompt">Instructions <span class="field-optional">optional</span></label>
        <textarea id="folderPrompt" v-model="prompt" rows="5" maxlength="20000"
                  placeholder="e.g. Answer as a reviewer of my thesis on coastal erosion. Cite sources." />
        <p class="field-hint">Added to every request in this folder's chats, after the system prompt and your own instructions.</p>
      </div>
      <p class="modal-note">The model's search of earlier chats looks only at the other chats in this folder.</p>
      <div v-if="error" class="organize-error" role="alert">{{ error }}</div>
      <div class="dialog-actions">
        <button type="button" @click="emit('close')">Cancel</button>
        <button type="submit" class="primary" :disabled="saving">{{ editing ? 'Save' : 'Create folder' }}</button>
      </div>
    </form>
  </Modal>
</template>
