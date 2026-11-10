<script setup lang="ts">
/**
 * A folder's dialogs, one job each:
 * - `new`: two steps. First its name and instructions, then (Next) the chats
 *   to bring in; nothing is created until the last step, so Cancel leaves no
 *   half-made folder behind.
 * - `edit`: its name and instructions.
 * - `chats`: which chats it holds. The chats in it collect at the top, each
 *   removable; the rest are a list under them to add from.
 * - `delete`: deleting it, asking first whether its chats stay (moved out to
 *   no folder, the default) or go with it.
 * This is the one place chats move between folders; a chat's own row only
 * renames or deletes it. The instructions go into every turn of the chats in
 * it, and a chat in a folder searches only the other chats in that folder
 * (search_chats), so both are said where the instructions are written.
 */
import { computed, nextTick, onMounted, ref } from 'vue';
import { useChats } from '../../stores/chats.ts';
import { useChat } from '../../stores/chat.ts';
import Modal from '../../ui/Modal.vue';
import Icon from '../../ui/Icon.vue';

export type FolderDialogMode = 'new' | 'edit' | 'chats' | 'delete';
const props = defineProps<{ folder: string | null, mode: FolderDialogMode }>();
const emit = defineEmits<{ close: [] }>();
const chats = useChats();
const current = useChat();
const deleteChats = ref(false);

const step = ref<1 | 2>(props.mode === 'chats' ? 2 : 1);
const name = ref(props.folder || '');
const prompt = ref(props.folder ? chats.prompts[props.folder] || '' : '');
const error = ref('');
const saving = ref(false);
const nameEl = ref<HTMLInputElement>();
const findEl = ref<HTMLInputElement>();

/* ---------- the chats in it ---------- */

const inFolder = (folder: string | null | undefined) => Boolean(props.folder) && folder === props.folder;
const before = chats.chats.filter((c) => inFolder(c.folder)).map((c) => c.id);
/** In the order they were added, the ones already in it first. */
const picked = ref<string[]>([...before]);
const filter = ref('');
const byId = computed(() => new Map(chats.chats.map((c) => [c.id, c])));
const pickedRows = computed(() => picked.value.map((id) => byId.value.get(id)).filter((c) => c !== undefined));
const available = computed(() => {
  const q = filter.value.trim().toLowerCase();
  const taken = new Set(picked.value);
  return chats.chats.filter((c) => !taken.has(c.id) && (!q || c.title.toLowerCase().includes(q)));
});
const sameChats = computed(() => before.length === picked.value.length && before.every((id) => picked.value.includes(id)));
const n = (count: number) => `${count} chat${count === 1 ? '' : 's'}`;

function add(id: string) { picked.value.push(id); }
function remove(id: string) { picked.value = picked.value.filter((p) => p !== id); }

/* ---------- words ---------- */

const title = computed(() => {
  if (props.mode === 'new') return 'New folder';
  if (props.mode === 'delete') return `Delete “${props.folder}”?`;
  return props.mode === 'edit' ? 'Name and instructions' : `Chats in “${props.folder}”`;
});
const subtitle = computed(() => {
  if (props.mode === 'new') return step.value === 1 ? 'Step 1 of 2: what it is' : 'Step 2 of 2: bring in chats, or skip this';
  if (props.mode === 'edit') return props.folder || '';
  if (props.mode === 'delete') return before.length ? `${n(before.length)} in it` : 'It has no chats';
  return `${n(picked.value.length)} in it`;
});
const submitLabel = computed(() => {
  if (props.mode === 'new') return step.value === 1 ? 'Next' : picked.value.length ? `Create with ${n(picked.value.length)}` : 'Create folder';
  if (props.mode === 'delete') return deleteChats.value && before.length ? `Delete folder and ${n(before.length)}` : 'Delete folder';
  return 'Save';
});
const icon = computed(() => ({ new: 'folderPlus', edit: 'folder', chats: 'folderOpen', delete: 'trash' })[props.mode]);

/* ---------- saving ---------- */

function focusStep() { nextTick(() => (step.value === 1 ? nameEl.value : findEl.value)?.focus()); }

async function submit() {
  error.value = '';
  if (step.value === 1) {
    if (!name.value.trim()) { error.value = 'Give the folder a name.'; nameEl.value?.focus(); return; }
    if (props.mode === 'new') {
      if (chats.folders.includes(name.value.trim())) { error.value = 'There is already a folder with that name.'; nameEl.value?.focus(); return; }
      step.value = 2;
      focusStep();
      return;
    }
  }
  saving.value = true;
  try {
    if (props.mode === 'delete' && props.folder) {
      const folder = props.folder;
      const gone = deleteChats.value && before.length > 0;
      await chats.deleteFolder(folder, gone);
      // The chat on screen went with it, or was about to start in it: start over outside any folder.
      if ((gone && current.chatId && before.includes(current.chatId)) || (!current.chatId && current.draftFolder === folder)) current.newChat();
    } else if (props.mode === 'edit' && props.folder) {
      const unchanged = name.value.trim() === props.folder && prompt.value.trim() === (chats.prompts[props.folder] || '');
      if (!unchanged) await chats.saveFolder(props.folder, { rename: name.value.trim(), prompt: prompt.value });
    } else if (props.mode === 'chats' && props.folder) {
      if (!sameChats.value) await chats.setFolderChats(props.folder, picked.value);
    } else {
      const folder = await chats.createFolder(name.value.trim(), prompt.value);
      if (picked.value.length) await chats.setFolderChats(folder, picked.value);
      chats.expanded.add(folder);
    }
    emit('close');
  } catch (err) {
    error.value = err.message || 'Could not save the folder.';
  } finally {
    saving.value = false;
  }
}

function back() { step.value = 1; error.value = ''; focusStep(); }

onMounted(() => { if (props.mode !== 'delete') focusStep(); });
</script>

<template>
  <Modal id="folderDialog" labelledby="folderDialogTitle" :icon="icon" :danger="mode === 'delete'"
         :title="title" :subtitle="subtitle" @close="emit('close')">
    <form id="folderForm" class="modal-body" @submit.prevent="submit">
      <template v-if="mode === 'delete'">
        <fieldset v-if="before.length" class="choice-list">
          <legend>Its chats</legend>
          <label class="choice">
            <input v-model="deleteChats" type="radio" name="folderChats" :value="false">
            <span><b>Keep them</b><small>{{ n(before.length) }} move to Chats, outside any folder</small></span>
          </label>
          <label class="choice">
            <input v-model="deleteChats" type="radio" name="folderChats" :value="true">
            <span><b>Delete them too</b><small>With their documents and images. This can't be undone.</small></span>
          </label>
        </fieldset>
        <p class="folder-delete-note">{{ chats.prompts[folder || ''] ? 'Its instructions are deleted with it.' : 'Only the folder goes.' }}</p>
      </template>

      <template v-else-if="step === 1">
        <div class="field">
          <label class="field-label" for="folderName">Name</label>
          <input id="folderName" ref="nameEl" v-model="name" maxlength="40" autocomplete="off" placeholder="e.g. Thesis, Client work">
        </div>
        <div class="field">
          <label class="field-label" for="folderPrompt">Instructions <span class="field-optional">optional</span></label>
          <textarea id="folderPrompt" v-model="prompt" rows="5" maxlength="20000"
                    placeholder="e.g. Answer as a reviewer of my thesis on coastal erosion. Cite sources." />
          <p class="field-hint">Added to every request in this folder's chats, after the system prompt and your own instructions.
            The model's search of earlier chats looks only at the other chats in this folder.</p>
        </div>
      </template>

      <template v-else>
        <div class="field">
          <span id="folderPickedLabel" class="field-label">In this folder <span class="field-optional">{{ picked.length }}</span></span>
          <ul v-if="pickedRows.length" class="folder-picked" aria-labelledby="folderPickedLabel">
            <li v-for="c in pickedRows" :key="c.id">
              <Icon name="chat" class="folder-picked-icon" aria-hidden="true" />
              <span class="folder-picked-title" :title="c.title">{{ c.title }}</span>
              <button type="button" class="folder-picked-remove" :aria-label="`Take “${c.title}” out of this folder`" title="Take out"
                      @click="remove(c.id)"><Icon name="x" /></button>
            </li>
          </ul>
          <p v-else class="folder-picked-empty">Nothing yet. Pick chats from the list below.</p>
        </div>
        <div class="field">
          <span id="folderAddLabel" class="field-label">Add chats</span>
          <input ref="findEl" v-model="filter" type="search" autocomplete="off" placeholder="Find a chat" aria-label="Find a chat to add">
          <ul class="folder-chats" aria-labelledby="folderAddLabel">
            <li v-for="c in available" :key="c.id">
              <button type="button" class="folder-chat" :title="c.folder ? `Now in ${c.folder}; adding moves it here` : 'Add to this folder'" @click="add(c.id)">
                <Icon name="plus" class="folder-chat-add" aria-hidden="true" />
                <span class="folder-chat-title">{{ c.title }}</span>
                <span v-if="c.folder" class="folder-chat-from">{{ c.folder }}</span>
              </button>
            </li>
            <li v-if="!available.length" class="folder-chats-empty">
              {{ filter.trim() ? 'No chat matches.' : chats.chats.length ? 'Every chat is in this folder.' : 'No chats yet.' }}
            </li>
          </ul>
          <p class="field-hint">A chat from another folder moves here. One taken out goes back to no folder.</p>
        </div>
      </template>

      <div v-if="error" class="organize-error" role="alert">{{ error }}</div>
      <div class="dialog-actions">
        <button v-if="mode === 'new' && step === 2" type="button" class="dialog-back" @click="back"><Icon name="arrowLeft" /> Back</button>
        <button type="button" @click="emit('close')">Cancel</button>
        <button type="submit" class="primary" :class="{ 'danger-solid': mode === 'delete' }" :disabled="saving">{{ submitLabel }}</button>
      </div>
    </form>
  </Modal>
</template>
