<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import { useChat } from '../stores/chat.ts';
import { useStickToBottom } from './stick-to-bottom.ts';
import UserMessage from './UserMessage.vue';
import AutomationRun from './AutomationRun.vue';
import AssistantTurn from './AssistantTurn.vue';
import Icon from '../ui/Icon.vue';

const chat = useChat();
const log = ref<HTMLElement>();
const wrap = ref<HTMLElement>();
const { pinned, pin } = useStickToBottom(log, wrap);

// A chat switch always lands on the newest message, whatever the chat before
// it was scrolled to; so does sending, which is a clear "show me the reply".
watch(() => chat.model, () => nextTick(pin));
watch(() => chat.model.items.length, (n, before) => {
  const last = chat.model.items[n - 1];
  if (n > before && last?.kind === 'user') pin();
});

defineExpose({ log });
</script>

<template>
  <div id="log" ref="log" :class="{ loading: chat.loading }" :aria-busy="chat.loading ? 'true' : undefined">
    <div id="wrap" ref="wrap" class="wrap">
      <template v-for="item in chat.model.items" :key="item.id">
        <UserMessage v-if="item.kind === 'user'" :item="item" />
        <AutomationRun v-else-if="item.kind === 'automation'" :origin="item.origin" />
        <AssistantTurn v-else-if="item.kind === 'turn'" :turn="item" />
        <div v-else class="err">{{ item.text }}</div>
      </template>
    </div>
  </div>
  <Transition name="fade">
    <button v-if="!pinned && !chat.empty" type="button" class="jump-latest" @click="pin">
      <Icon name="arrowDown" size="1rem" /><span>{{ chat.busy ? 'Jump to latest' : 'Back to bottom' }}</span>
    </button>
  </Transition>
</template>
