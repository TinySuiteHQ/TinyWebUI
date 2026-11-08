<script setup lang="ts">
/**
 * One assistant turn, as the person reads it: a quiet status while it works,
 * anything that needs them inline, and then the answer -- with the work
 * folded into one row above it and the cost in a meta line under it.
 */
import { computed, ref } from 'vue';
import type { Turn, ToolStep } from '../../model/turn_model.ts';
import ActivityDrawer from './ActivityDrawer.vue';
import ApprovalPrompt from './ApprovalPrompt.vue';
import QuestionCard from './QuestionCard.vue';
import Markdown from '../Markdown.vue';
import UsageLine from './UsageLine.vue';
import Icon from '../../ui/Icon.vue';

const props = defineProps<{ turn: Turn }>();

const hasActivity = computed(() => props.turn.activity.some((e) => e.kind !== 'usage'));
/** The row shows while working (it is the status line) and afterwards if there was work to fold. */
const showActivity = computed(() => !props.turn.done || hasActivity.value);
const stepOf = (id: string) => props.turn.activity.find((e): e is ToolStep => e.kind === 'tool' && e.id === id);
const rounds = computed(() => props.turn.usage.length);

const copied = ref(false);
async function copy() {
  try {
    await navigator.clipboard.writeText(props.turn.answer);
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 1500);
  } catch { /* clipboard blocked: nothing to say */ }
}
</script>

<template>
  <div class="turn" :class="{ live: !turn.done }">
    <ActivityDrawer v-if="showActivity" :turn="turn" />
    <template v-for="p in turn.pending" :key="p.kind === 'approval' ? p.callId : p.qid">
      <ApprovalPrompt v-if="p.kind === 'approval'" :pending="p" :step="stepOf(p.callId)" />
      <QuestionCard v-else :pending="p" />
    </template>
    <div v-for="(n, i) in turn.notices" :key="`n${i}`" class="notice">{{ n }}</div>
    <div v-if="turn.answer" class="msg assistant answer" :class="{ final: turn.done, streaming: !turn.done }">
      <Markdown :text="turn.answer" />
    </div>
    <div v-for="(e, i) in turn.errors" :key="`e${i}`" class="err">{{ e }}</div>
    <div v-if="turn.done && (turn.answer || rounds)" class="turn-meta">
      <button v-if="turn.answer" type="button" class="icon-btn" :title="copied ? 'Copied' : 'Copy answer'" aria-label="Copy answer" @click="copy">
        <Icon :name="copied ? 'check' : 'copy'" size="1rem" />
      </button>
      <UsageLine v-if="rounds" :raws="turn.usage" :label="rounds > 1 ? `${rounds} rounds` : undefined" />
    </div>
  </div>
</template>
