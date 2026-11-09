<script setup lang="ts">
/**
 * Says what a change to the history will do before it is done: what goes,
 * what changes or what a fork copies, counted from the transcript. A fork
 * also asks whether the chat's artifacts (its documents and images) go along.
 */
import { computed, ref } from 'vue';
import { useChat, type HistoryAction } from '../../stores/chat.ts';
import { tally, type Tally } from '../../model/turn_model.ts';
import Modal from '../../ui/Modal.vue';

const props = defineProps<{ action: HistoryAction }>();
const chat = useChat();
const withFiles = ref(true);

const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const items = computed(() => chat.model.items);
const at = computed(() => items.value.findIndex((it) => it.id === props.action.itemId));

/** "2 answers, 1 later question, 5 tool calls and 1 image". */
function list(t: Tally, { laterQuestions = false } = {}) {
  const parts = [
    t.questions ? n(t.questions, laterQuestions ? 'later question' : 'question') : '',
    t.answers ? n(t.answers, 'answer') : '',
    t.toolCalls ? n(t.toolCalls, 'tool call') : '',
    t.images ? n(t.images, 'image') : ''
  ].filter(Boolean);
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0] || 'nothing else';
}

const view = computed(() => {
  const a = props.action;
  const i = at.value;
  const after = (from: number) => tally(items.value.slice(from));
  switch (a.kind) {
    case 'edit-question':
    case 'retry': {
      const gone = after(i + 1);
      return {
        title: a.kind === 'retry' ? 'Ask this question again?' : 'Resubmit the edited question?',
        lines: [
          a.kind === 'retry' ? 'The question is asked again and answered from scratch.' : 'Your edited question replaces this one and is answered again.',
          `This removes what came after it: ${list(gone, { laterQuestions: true })}.`,
          ...(gone.documents ? ['Attached documents stay in this chat\'s artifacts.'] : [])
        ],
        confirm: a.kind === 'retry' ? 'Ask again' : 'Resubmit', icon: a.kind === 'retry' ? 'retry' : 'edit',
        danger: gone.answers + gone.questions > 0
      };
    }
    case 'delete-question': {
      const gone = after(i);
      return {
        title: 'Delete this question and everything after it?',
        lines: [
          `This removes ${list(gone)}. The chat ends just before this question.`,
          ...(gone.documents ? ['Attached documents stay in this chat\'s artifacts.'] : []),
          'This can\'t be undone.'
        ],
        confirm: 'Delete', danger: true, icon: 'trash'
      };
    }
    case 'delete-answer': {
      const gone = after(i);
      return {
        title: 'Delete this answer and everything after it?',
        lines: [
          `This removes ${list(gone)}. The question stays, so you can ask it again.`,
          ...(gone.documents ? ['Attached documents stay in this chat\'s artifacts.'] : []),
          'This can\'t be undone.'
        ],
        confirm: 'Delete', danger: true, icon: 'trash'
      };
    }
    case 'edit-answer':
      return {
        title: 'Save your edit of this answer?',
        lines: [
          'This changes 1 answer. Nothing runs again.',
          'From now on the model reads your version as what it said, in this chat\'s later questions.'
        ],
        confirm: 'Save', danger: false, icon: 'edit'
      };
    case 'fork': {
      const copied = tally(items.value.slice(0, i + 1));
      return {
        title: 'Fork this chat here?',
        lines: [
          `A new chat is made with ${list(copied)}, up to and including this ${a.at}. It is listed under “${chat.model.chat.title}”, which stays as it is.`,
          ...(a.at === 'question' ? ['The question is left unanswered in the fork, to be asked again there.'] : [])
        ],
        confirm: 'Fork', danger: false, icon: 'fork',
        files: copied.documents + copied.images ? { documents: copied.documents, images: copied.images } : null
      };
    }
  }
  return { title: '', lines: [], confirm: 'OK', danger: false, icon: 'history' };
});
const files = computed(() => ('files' in view.value ? view.value.files : null));
</script>

<template>
  <Modal id="historyDialog" labelledby="historyDialogTitle" :title="view.title" :icon="view.icon" :danger="view.danger" @close="chat.cancelAction()">
    <form id="historyForm" class="modal-body" @submit.prevent="chat.confirmAction({ withFiles: Boolean(files) && withFiles })">
      <p v-for="(line, i) in view.lines" :key="i">{{ line }}</p>
      <fieldset v-if="files" class="history-files">
        <legend>Artifacts</legend>
        <label class="inline-check"><input v-model="withFiles" type="radio" :value="true">
          Bring them along: {{ [files.documents ? n(files.documents, 'document') : '', files.images ? n(files.images, 'image') : ''].filter(Boolean).join(' and ') }}</label>
        <label class="inline-check"><input v-model="withFiles" type="radio" :value="false">
          Leave them out (the fork keeps the questions' text, not their files)</label>
      </fieldset>
      <p v-else-if="action.kind === 'fork'" class="history-note">There are no artifacts to bring along.</p>
      <div class="dialog-actions">
        <button type="button" @click="chat.cancelAction()">Cancel</button>
        <button type="submit" class="primary" :class="{ 'danger-solid': view.danger }">{{ view.confirm }}</button>
      </div>
    </form>
  </Modal>
</template>
