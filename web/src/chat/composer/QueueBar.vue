<script setup lang="ts">
/**
 * Messages sent while a turn runs. Steering lands at the next safe point
 * inside the run; a follow-up starts its own turn once the run is done. The
 * server owns that queue -- this draws it. Held messages are the page's own:
 * they go nowhere until their send is clicked.
 *
 * On a phone a stack of them would push the conversation off the screen, so
 * more than one folds into a single "N queued" row until it is opened.
 */
import { computed, ref } from 'vue';
import { useChat } from '../../stores/chat.ts';
import { useUi } from '../../stores/ui.ts';
import Icon from '../../ui/Icon.vue';

const chat = useChat();
const ui = useUi();
const removing = ref(new Set<string>());
const expanded = ref(false);

const count = computed(() => chat.model.queue.length + chat.heldHere.length);
const folds = computed(() => ui.narrow && count.value > 1);
const shown = computed(() => !folds.value || expanded.value);

async function drop(id: string, item: Parameters<typeof chat.removeQueued>[0]) {
  removing.value.add(id);
  await chat.removeQueued(item);
  removing.value.delete(id);
}
</script>

<template>
  <div v-if="count" id="queue" class="queue">
    <button v-if="folds" type="button" class="queue-fold" :aria-expanded="expanded" aria-controls="queue-items" @click="expanded = !expanded">
      <span>{{ count }} queued</span><Icon class="chev" name="chevronDown" size="1rem" />
    </button>
    <div v-show="shown" id="queue-items" class="queue-items">
      <div v-for="h in chat.heldHere" :key="h.id" class="queued held">
        <span class="queued-kind" title="Waits here until you send it">held</span>
        <span class="queued-text">{{ h.content }}</span>
        <button type="button" class="queued-send" aria-label="Send held message" @click="chat.sendHeld(h)">Send</button>
        <button type="button" class="queued-drop" aria-label="Remove held message" @click="chat.dropHeld(h)">×</button>
      </div>
      <div v-for="q in chat.model.queue" :key="q.id" class="queued" :class="q.kind">
        <span class="queued-kind" :title="q.kind === 'steer' ? 'Delivered as soon as the current tool calls finish' : 'Sent as a new message once this turn is done'">
          {{ q.kind === 'steer' ? 'next step' : 'after this' }}
        </span>
        <span class="queued-text">{{ q.content }}</span>
        <button type="button" class="queued-drop" aria-label="Remove queued message" :disabled="removing.has(q.id)" @click="drop(q.id, q)">×</button>
      </div>
    </div>
  </div>
</template>
