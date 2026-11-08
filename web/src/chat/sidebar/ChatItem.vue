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
  <div class="chat-item" :class="{ active, 'has-unread': chat.unread && !chat.running }" tabindex="0" role="button" :aria-current="active ? 'true' : undefined"
       @click="emit('open')" @keydown="onKey">
    <span class="t">{{ chat.title }}</span>
    <!-- A turn is the server's, not this tab's: a chat can be working with nothing watching it. -->
    <span v-if="chat.running" class="dot" title="working" aria-label="working" />
    <!-- An automation posted here and nobody has opened it since. -->
    <span v-else-if="chat.unread" class="unread" title="new automation result" aria-label="new automation result" />
    <button class="organize-chat" type="button" title="Chat options" :aria-label="`Options for “${chat.title}”`"
            @click.stop="emit('organize')" @keydown.stop><Icon name="more" /></button>
  </div>
</template>
