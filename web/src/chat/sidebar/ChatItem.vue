<script setup lang="ts">
import type { ChatRow } from '../../stores/chats.ts';
import Icon from '../../ui/Icon.vue';

defineProps<{ chat: ChatRow, active: boolean }>();
const emit = defineEmits<{ open: [], organize: [] }>();

// A div with a click handler is unreachable without a mouse, so the row
// carries the button contract itself: focusable, named, activated by key.
function onKey(e: KeyboardEvent) {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault(); // space would scroll the list instead
  emit('open');
}
</script>

<template>
  <div class="chat-item" :class="{ active }" tabindex="0" role="button" :aria-current="active ? 'true' : undefined"
       @click="emit('open')" @keydown="onKey">
    <span class="t">{{ chat.title }}</span>
    <!-- A turn is the server's, not this tab's: a chat can be working with nothing watching it. -->
    <span v-if="chat.running" class="dot" title="working" aria-label="working" />
    <button class="organize-chat" type="button" title="Chat options" :aria-label="`Options for “${chat.title}”`"
            @click.stop="emit('organize')" @keydown.stop><Icon name="more" /></button>
  </div>
</template>
