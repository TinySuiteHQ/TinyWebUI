<script setup lang="ts">
/**
 * A folder, new or existing: its name, its own instructions, and which chats
 * are in it, picked from a list of every chat. This is the one place chats
 * move between folders; a chat's own menu only renames or deletes it. The
 * instructions go into every turn of the chats in it, after the system prompt
 * and the person's own; and a chat in a folder searches only the other chats
 * in that folder (search_chats), so both are said here.
 */
import { computed, onMounted, ref } from 'vue';
import { useChats } from '../../stores/chats.ts';
import Modal from '../../ui/Modal.vue';

const props = defineProps<{ folder?: string | null }>();
const emit = defineEmits<{ close: [] }>();
const chats = useChats();

const editing = computed(() => Boolean(props.folder));
const name = ref(props.folder || '');
const prompt = ref(props.folder ? chats.prompts[props.folder] || '' : '');
const inFolder = (folder: string | null | undefined) => Boolean(props.folder) && folder === props.folder;
const picked = ref(new Set<string>(chats.chats.filter((c) => inFolder(c.folder)).map((c) => c.id)));
const filter = ref('');
const error = ref('');
const saving = ref(false);
const input = ref<HTMLInputElement>();

// This folder's chats first, then the rest, each newest first as the sidebar has them.
const listed = computed(() => {
  const q = filter.value.trim().toLowerCase();
  const all = chats.chats.filter((c) => !q || c.title.toLowerCase().includes(q));
  return [...all.filter((c) => inFolder(c.folder)), ...all.filter((c) => !inFolder(c.folder))];
});
const subtitle = computed(() => (editing.value ? `${picked.value.size} chat${picked.value.size === 1 ? '' : 's'} in it` : 'Group related chats, and give them instructions of their own.'));

const sameChats = computed(() => {
  const before = chats.chats.filter((c) => inFolder(c.folder)).map((c) => c.id);
  return before.length === picked.value.size && before.every((id) => picked.value.has(id));
});
const unchanged = computed(() => editing.value && sameChats.value
  && name.value.trim() === props.folder && prompt.value.trim() === (chats.prompts[props.folder || ''] || ''));

function toggle(id: string, on: boolean) {
  if (on) picked.value.add(id);
  else picked.value.delete(id);
}

async function save() {
  if (!name.value.trim()) { error.value = 'Give the folder a name.'; input.value?.focus(); return; }
  if (unchanged.value) { emit('close'); return; }
  saving.value = true;
  error.value = '';
  try {
    let folder: string;
    if (props.folder) {
      await chats.saveFolder(props.folder, { rename: name.value.trim(), prompt: prompt.value });
      folder = name.value.trim();
    } else {
      folder = await chats.createFolder(name.value.trim(), prompt.value);
    }
    // A new folder with nothing picked has no chats to set.
    if (props.folder ? !sameChats.value : picked.value.size) await chats.setFolderChats(folder, [...picked.value]);
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
        <span class="field-label" id="folderChatsLabel">Chats in this folder</span>
        <input v-model="filter" class="folder-chats-filter" type="search" autocomplete="off" placeholder="Find a chat" aria-label="Find a chat">
        <ul class="folder-chats" role="group" aria-labelledby="folderChatsLabel">
          <li v-for="c in listed" :key="c.id">
            <label class="folder-chat">
              <input type="checkbox" :checked="picked.has(c.id)" @change="toggle(c.id, ($event.target as HTMLInputElement).checked)">
              <span class="folder-chat-title">{{ c.title }}</span>
              <span v-if="c.folder && !inFolder(c.folder)" class="folder-chat-from" :title="`Now in ${c.folder}; ticking moves it here`">{{ c.folder }}</span>
            </label>
          </li>
          <li v-if="!listed.length" class="folder-chats-empty">{{ chats.chats.length ? 'No chat matches.' : 'No chats yet.' }}</li>
        </ul>
        <p class="field-hint">Tick the chats to keep here. A chat in another folder moves here; one unticked leaves for no folder.</p>
      </div>
      <div class="field">
        <label class="field-label" for="folderPrompt">Instructions <span class="field-optional">optional</span></label>
        <textarea id="folderPrompt" v-model="prompt" rows="4" maxlength="20000"
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
