<script setup lang="ts">
/**
 * The message box. While a turn runs, send becomes stop -- unless something
 * is typed, which the arrow then queues into the turn (Enter steers it,
 * Alt+Enter holds it for later). Staged files sit inside the box, above the
 * text, so what goes with the message is read with it.
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useChat } from '../../stores/chat.ts';
import { useUi } from '../../stores/ui.ts';
import Icon from '../../ui/Icon.vue';
import QueueBar from './QueueBar.vue';
import AttachmentTray from './AttachmentTray.vue';
import ComposerBar from './ComposerBar.vue';

const chat = useChat();
const ui = useUi();

const input = ref<HTMLTextAreaElement>();
const bar = ref<InstanceType<typeof ComposerBar>>();

const stop = computed(() => chat.busy && !chat.draft.trim());
const sendLabel = computed(() => (stop.value ? 'Stop' : chat.busy ? 'Queue message (Alt+Enter: hold for later)' : 'Send'));

function autosize() {
  const el = input.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 190)}px`;
}
watch(() => chat.draft, () => nextTick(autosize));
watch(() => chat.focusTick, () => { if (!ui.narrow) nextTick(() => input.value?.focus()); });

function onKey(e: KeyboardEvent) {
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
  e.preventDefault();
  if (e.altKey && chat.busy) chat.holdInput();
  else chat.send();
}

onMounted(() => { if (!ui.narrow) input.value?.focus(); });
</script>

<template>
  <form id="form" class="composer" @submit.prevent="chat.send()" @dragover.prevent @dragenter.prevent @drop.prevent="bar?.stageAll($event.dataTransfer?.files)">
    <QueueBar />
    <AttachmentTray />
    <textarea id="input" ref="input" v-model="chat.draft" class="composer-input" rows="1" aria-label="Message"
              :placeholder="chat.busy ? 'Add a message to this turn…' : 'Ask anything…'" @keydown="onKey" @paste="bar?.onPaste($event)" />
    <ComposerBar ref="bar" :centred="chat.empty">
      <button id="send" class="primary composer-send" type="submit" :class="{ stop }" :aria-label="sendLabel"
              :title="chat.busy && !stop ? 'Enter: next step · Alt+Enter: hold for later' : ''">
        <Icon :name="stop ? 'stop' : 'send'" />
      </button>
    </ComposerBar>
  </form>
</template>
