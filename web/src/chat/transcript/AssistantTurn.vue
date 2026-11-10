<script setup lang="ts">
/**
 * One assistant turn, as the person reads it: a quiet status while it works,
 * anything that needs them inline, and then the answer -- with the work
 * folded into one row above it and the cost in a meta line under it. A
 * settled answer can be copied, edited in place, forked from or deleted; each
 * change says what it will do first (HistoryDialog).
 */
import { computed, nextTick, ref } from 'vue';
import type { Turn, ToolStep } from '../../model/turn_model.ts';
import ActivityDrawer from './ActivityDrawer.vue';
import ApprovalPrompt from './ApprovalPrompt.vue';
import QuestionCard from './QuestionCard.vue';
import Markdown from '../Markdown.vue';
import UsageLine from './UsageLine.vue';
import Icon from '../../ui/Icon.vue';
import { useChat } from '../../stores/chat.ts';

const props = defineProps<{ turn: Turn, questionSeq: number | null }>();
const chat = useChat();

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

/* ---------- changing it: only once it is settled and stored ---------- */

const stored = computed(() => props.turn.done && props.questionSeq != null);
const editing = ref(false);
const text = ref('');
const area = ref<HTMLTextAreaElement>();

/** Grow with the text (wrapped lines included, which counting \n misses); CSS caps it at 60vh, then it scrolls. */
function fit() {
  const el = area.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight + 2}px`;
}
function beginEdit() {
  if (chat.busy) return;
  text.value = props.turn.answer;
  editing.value = true;
  nextTick(() => { fit(); area.value?.focus(); });
}
async function save() {
  const content = text.value;
  const seq = props.questionSeq;
  if (!content.trim() || seq == null) return;
  if (content === props.turn.answer) { editing.value = false; return; }
  if (await chat.askAction({ kind: 'edit-answer', itemId: props.turn.id, seq, content })) editing.value = false;
}
function fork() { if (props.questionSeq != null) chat.askAction({ kind: 'fork', itemId: props.turn.id, seq: props.questionSeq, at: 'answer' }); }
function remove() { if (props.questionSeq != null) chat.askAction({ kind: 'delete-answer', itemId: props.turn.id, seq: props.questionSeq }); }
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); editing.value = false; }
  // Answers are long and markdown: Enter is a new line here; Ctrl/Cmd+Enter saves.
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
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
    <div v-if="turn.answer && !editing" class="msg assistant answer" :class="{ final: turn.done, streaming: !turn.done }">
      <Markdown :text="turn.answer" />
    </div>
    <form v-if="editing" class="composer composer-inline answer-edit" @submit.prevent="save">
      <textarea ref="area" v-model="text" class="composer-input" rows="3" aria-label="Edit answer" spellcheck="true"
                @keydown="onKey" @input="fit" />
      <div class="composer-bar">
        <span class="edit-hint">Markdown · Ctrl+Enter saves · Esc cancels</span>
        <span class="grow" />
        <button type="button" class="edit-cancel" @click="editing = false">Cancel</button>
        <button type="submit" class="primary edit-save" :disabled="!text.trim()">Save</button>
      </div>
    </form>
    <div v-for="(e, i) in turn.errors" :key="`e${i}`" class="err">{{ e }}</div>
    <div v-if="turn.done && (turn.answer || rounds || stored) && !editing" class="turn-meta">
      <button v-if="turn.answer" type="button" class="icon-btn" :title="copied ? 'Copied' : 'Copy answer'" aria-label="Copy answer" @click="copy">
        <Icon :name="copied ? 'check' : 'copy'" size="1rem" />
      </button>
      <template v-if="stored">
        <button v-if="turn.answer" type="button" class="icon-btn" title="Edit this answer in place" aria-label="Edit answer"
                :disabled="chat.busy" @click="beginEdit"><Icon name="edit" size="1rem" /></button>
        <button type="button" class="icon-btn" title="Fork: a new chat up to this answer, listed under this one" aria-label="Fork from this answer"
                :disabled="chat.busy" @click="fork"><Icon name="fork" size="1rem" /></button>
        <button type="button" class="icon-btn" title="Delete this answer and everything after it" aria-label="Delete answer"
                :disabled="chat.busy" @click="remove"><Icon name="trash" size="1rem" /></button>
      </template>
      <UsageLine v-if="rounds" :raws="turn.usage" :label="rounds > 1 ? `${rounds} rounds` : undefined" />
    </div>
  </div>
</template>
