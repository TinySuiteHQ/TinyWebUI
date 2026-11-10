<script setup lang="ts">
/**
 * One chat in the sidebar. On hover (or focus, or always on touch) it shows
 * edit and delete: edit turns the title into a field in place, delete removes
 * the chat after a second click, since it cannot be undone. Moving chats into
 * folders is done from the folder (FolderDialog), not here.
 */
import { nextTick, onBeforeUnmount, ref } from 'vue';
import { api } from '../../core/api.ts';
import { useChats, type ChatRow } from '../../stores/chats.ts';
import { useChat } from '../../stores/chat.ts';
import Icon from '../../ui/Icon.vue';

const props = withDefaults(defineProps<{ chat: ChatRow, active: boolean, depth?: number }>(), { depth: 0 });
const emit = defineEmits<{ open: [] }>();
const chats = useChats();
const current = useChat();

const editing = ref(false);
const draft = ref('');
const field = ref<HTMLInputElement>();
const armed = ref(false);
let disarm: ReturnType<typeof setTimeout> | undefined;

// A div with a click handler is unreachable without a mouse, so the row
// carries the button contract itself: focusable, named, activated by key.
function onKey(e: KeyboardEvent) {
  if (editing.value || (e.key !== 'Enter' && e.key !== ' ')) return;
  e.preventDefault(); // space would scroll the list instead
  emit('open');
}

function startEdit() {
  draft.value = props.chat.title;
  editing.value = true;
  nextTick(() => { field.value?.focus(); field.value?.select(); });
}
async function commit() {
  if (!editing.value) return;
  editing.value = false;
  const title = draft.value.trim();
  if (!title || title === props.chat.title) return;
  try {
    const renamed = await chats.renameChat(props.chat.id, title);
    if (current.chatId === props.chat.id && current.model.chat) current.model.chat.title = renamed;
  } catch (err) { current.addError(`Could not rename the chat: ${err.message}`); }
}
function onFieldKey(e: KeyboardEvent) {
  e.stopPropagation();
  if (e.key === 'Enter') { e.preventDefault(); commit(); }
  if (e.key === 'Escape') { e.preventDefault(); editing.value = false; }
}

async function remove() {
  if (!armed.value) {
    armed.value = true;
    clearTimeout(disarm);
    disarm = setTimeout(() => { armed.value = false; }, 3000);
    return;
  }
  clearTimeout(disarm);
  const id = props.chat.id;
  try { await api.del(`/api/chats/${id}`); } catch (err) { armed.value = false; current.addError(`Could not delete the chat: ${err.message}`); return; }
  await chats.load();
  if (current.chatId === id) current.newChat();
}
onBeforeUnmount(() => clearTimeout(disarm));
</script>

<template>
  <div class="chat-item" :class="{ active, editing, armed, 'has-unread': chat.unread && !chat.running, fork: depth > 0 }"
       :style="depth ? { '--depth': Math.min(depth, 4) } : undefined" :tabindex="editing ? -1 : 0" role="button" :aria-current="active ? 'true' : undefined"
       @click="!editing && emit('open')" @keydown="onKey">
    <Icon v-if="depth" class="fork-mark" name="fork" size=".8rem" aria-hidden="true" />
    <input v-if="editing" ref="field" v-model="draft" class="chat-rename" maxlength="120" :aria-label="`Rename “${chat.title}”`"
           @click.stop @keydown="onFieldKey" @blur="commit">
    <span v-else class="t" :title="depth ? `Fork: ${chat.title}` : undefined">{{ chat.title }}</span>
    <template v-if="!editing">
      <!-- A turn is the server's, not this tab's: a chat can be working with nothing watching it. -->
      <span v-if="chat.running" class="dot" title="working" aria-label="working" />
      <!-- An automation posted here and nobody has opened it since. -->
      <span v-else-if="chat.unread" class="unread" title="new automation result" aria-label="new automation result" />
      <span class="chat-actions">
        <button class="chat-action" type="button" title="Rename" :aria-label="`Rename “${chat.title}”`"
                @click.stop="startEdit" @keydown.stop><Icon name="edit" /></button>
        <button class="chat-action chat-delete" type="button" :title="armed ? 'Click again to delete' : 'Delete'"
                :aria-label="armed ? `Click again to delete “${chat.title}”` : `Delete “${chat.title}”`"
                @click.stop="remove" @keydown.stop @blur="armed = false"><Icon :name="armed ? 'check' : 'trash'" /></button>
      </span>
    </template>
  </div>
</template>
