<script setup lang="ts">
/**
 * One chat in the sidebar. On hover (or focus, or always on touch) it shows
 * one "…" button, the same as a folder row: its menu pins it above the
 * folders, renames the title in place, or deletes the chat after a second
 * click, since that cannot be undone.
 * Moving chats into folders is done from the folder (FolderDialog), not here.
 */
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { api } from '../../core/api.ts';
import { useChats, type ChatRow } from '../../stores/chats.ts';
import { useChat } from '../../stores/chat.ts';
import Icon from '../../ui/Icon.vue';
import Popover from '../../ui/Popover.vue';

const props = withDefaults(defineProps<{ chat: ChatRow, active: boolean, depth?: number }>(), { depth: 0 });
const emit = defineEmits<{ open: [] }>();
const chats = useChats();
const current = useChat();

const wrapEl = ref<HTMLElement>();
const menuBtn = ref<HTMLButtonElement>();
const menuOpen = ref(false);
const pop = ref<InstanceType<typeof Popover>>();
const editing = ref(false);
const draft = ref('');
const field = ref<HTMLInputElement>();
const armed = ref(false);

// A div with a click handler is unreachable without a mouse, so the row
// carries the button contract itself: focusable, named, activated by key.
function onKey(e: KeyboardEvent) {
  if (editing.value || (e.key !== 'Enter' && e.key !== ' ')) return;
  e.preventDefault(); // space would scroll the list instead
  emit('open');
}

function closeMenu(refocus = false) {
  menuOpen.value = false;
  armed.value = false;
  if (refocus) menuBtn.value?.focus();
}
function onDocPointer(e: PointerEvent) {
  // On a phone the menu is a sheet under body, outside the row.
  const t = e.target as Node;
  if (!wrapEl.value?.contains(t) && !pop.value?.el?.contains(t)) closeMenu();
}
function onDocKey(e: KeyboardEvent) {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(true); }
}
// Listening only while open: a long list would otherwise hold a listener per row.
watch(menuOpen, (open) => {
  if (open) {
    document.addEventListener('pointerdown', onDocPointer);
    document.addEventListener('keydown', onDocKey, true);
  } else {
    document.removeEventListener('pointerdown', onDocPointer);
    document.removeEventListener('keydown', onDocKey, true);
  }
});
onBeforeUnmount(() => { menuOpen.value = false; document.removeEventListener('pointerdown', onDocPointer); document.removeEventListener('keydown', onDocKey, true); });

function startEdit() {
  closeMenu();
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

async function togglePin() {
  closeMenu();
  try { await chats.pinChat(props.chat.id, props.chat.pinned_at == null); } catch (err) { current.addError(`Could not pin the chat: ${err.message}`); }
}

async function remove() {
  if (!armed.value) { armed.value = true; return; }
  closeMenu();
  const id = props.chat.id;
  try { await api.del(`/api/chats/${id}`); } catch (err) { current.addError(`Could not delete the chat: ${err.message}`); return; }
  await chats.load();
  if (current.chatId === id) current.newChat();
}
</script>

<template>
  <div ref="wrapEl" class="chat-item-wrap" :class="{ 'menu-open': menuOpen }">
    <div class="chat-item" :class="{ active, editing, 'has-unread': chat.unread && !chat.running, fork: depth > 0 }"
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
          <button ref="menuBtn" class="chat-action" type="button" title="Chat options" :aria-label="`Options for “${chat.title}”`"
                  aria-haspopup="menu" :aria-expanded="menuOpen" @click.stop="menuOpen ? closeMenu() : (menuOpen = true)" @keydown.stop><Icon name="more" /></button>
        </span>
      </template>
    </div>
    <!-- Beside the row, not in it: the row is itself a button. -->
    <Popover v-if="menuOpen" ref="pop" side="right" class="row-menu" :aria-label="`Chat “${chat.title}”`">
      <button type="button" class="pop-item" role="menuitem" @click="togglePin">
        <Icon :name="chat.pinned_at != null ? 'unpin' : 'pin'" /><span class="pop-name">{{ chat.pinned_at != null ? 'Unpin' : 'Pin' }}</span>
      </button>
      <button type="button" class="pop-item" role="menuitem" @click="startEdit"><Icon name="edit" /><span class="pop-name">Rename</span></button>
      <hr class="pop-sep">
      <button type="button" class="pop-item pop-danger" role="menuitem" @click="remove">
        <Icon :name="armed ? 'check' : 'trash'" /><span class="pop-name">{{ armed ? 'Click again to delete' : 'Delete' }}</span>
      </button>
    </Popover>
  </div>
</template>
