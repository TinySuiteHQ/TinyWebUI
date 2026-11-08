<script setup lang="ts">
/**
 * An ask_user question: the run is paused on it until it is answered,
 * skipped, times out or is stopped. Like approvals, it stays until the server
 * confirms (question_done), so every tab watching the run settles too.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { Question } from './turn-model.ts';
import { useChat } from '../stores/chat.ts';

const props = defineProps<{ pending: Question }>();
const chat = useChat();
const locked = ref(false);
const free = ref('');
const now = ref(Date.now());
const input = ref<HTMLInputElement>();
let tick: ReturnType<typeof setInterval> | undefined;

const clock = computed(() => {
  if (!props.pending.deadline) return '';
  const left = Math.max(0, Math.ceil((props.pending.deadline - now.value) / 1000));
  return `continues on its own in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
});

async function send(body: { answer: string } | { skip: true }) {
  locked.value = true;
  try { await chat.answer(props.pending.qid, body); } catch (err) {
    locked.value = false;
    chat.addError(err.message);
  }
}
function submitFree() { if (free.value.trim()) send({ answer: free.value.trim() }); }

onMounted(() => {
  if (props.pending.deadline) tick = setInterval(() => { now.value = Date.now(); }, 1000);
  if (props.pending.allowFreeText) input.value?.focus({ preventScroll: true });
});
onBeforeUnmount(() => clearInterval(tick));
</script>

<template>
  <div class="prompt-card question" role="group" aria-label="Question from the assistant">
    <div class="prompt-head"><span class="prompt-kicker">Question for you</span></div>
    <p class="ask-q">{{ pending.question }}</p>
    <div v-if="pending.choices.length" class="ask-choices">
      <button v-for="c in pending.choices" :key="c" type="button" :disabled="locked" @click="send({ answer: c })">{{ c }}</button>
    </div>
    <form v-if="pending.allowFreeText" class="ask-free" @submit.prevent="submitFree">
      <input ref="input" v-model="free" :placeholder="pending.choices.length ? 'or type an answer…' : 'your answer…'" aria-label="Answer" :disabled="locked">
      <button type="submit" class="primary" :disabled="locked || !free.trim()">Answer</button>
    </form>
    <div class="ask-foot">
      <button type="button" class="quiet" :disabled="locked" @click="send({ skip: true })">Continue without me</button>
      <span v-if="clock" class="ask-clock">{{ clock }}</span>
    </div>
  </div>
</template>
