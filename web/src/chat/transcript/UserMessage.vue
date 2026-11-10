<script setup lang="ts">
/**
 * A question the person asked: a bubble, with its attachments. One that is in
 * the store (it has a seq) can be copied, edited, asked again, forked or
 * deleted; each change says what it will do first (HistoryDialog). Editing
 * opens a small composer in place, with the + and the model chip: files kept,
 * dropped or added there go along only when it is resubmitted.
 */
import { computed, nextTick, ref } from 'vue';
import type { UserItem, Img } from '../../model/turn_model.ts';
import { useChat } from '../../stores/chat.ts';
import { useViewer, type ViewItem } from '../../stores/viewer.ts';
import Icon from '../../ui/Icon.vue';
import ComposerBar from '../composer/ComposerBar.vue';
import AttachmentTray from '../composer/AttachmentTray.vue';

const props = defineProps<{ item: UserItem }>();
const chat = useChat();

const editing = computed(() => chat.editing === props.item.id);
const text = ref('');
const keptDocs = ref(new Set<string>());
const keptImages = ref(new Set<number>());
const area = ref<HTMLTextAreaElement>();
const bar = ref<InstanceType<typeof ComposerBar>>();
const copied = ref(false);

const src = (img: Img) => `data:${img.mime};base64,${img.dataBase64 ?? img.data}`;
const rows = computed(() => Math.min(12, text.value.split('\n').length + 1));
const wire = (img: Img) => ({ mime: img.mime, data: img.data ?? img.dataBase64 });
// Opens in the app's viewer, stepping through this message's other files.
const viewer = useViewer();
function view(kind: 'doc' | 'image', i: number) {
  const list: ViewItem[] = [
    ...props.item.docs.map((d): ViewItem => ({ kind: 'document', name: d.filename, id: d.id })),
    ...props.item.images.map((img, j): ViewItem => ({ kind: 'image', name: img.filename || `image ${j + 1}`, src: src(img) }))
  ];
  viewer.show(list, kind === 'doc' ? i : props.item.docs.length + i);
}

function beginEdit() {
  if (chat.busy) return;
  text.value = props.item.text;
  keptDocs.value = new Set(props.item.docs.map((d) => d.id));
  keptImages.value = new Set(props.item.images.map((_, i) => i));
  chat.beginEdit(props.item.id);
  nextTick(() => { area.value?.focus(); area.value?.setSelectionRange(text.value.length, text.value.length); });
}
const cancel = () => chat.beginEdit(null);

function toggle<T>(set: Set<T>, v: T) { if (set.has(v)) set.delete(v); else set.add(v); }

async function save() {
  const next = text.value.trim();
  const { docs, images, seq } = props.item;
  if (!next || seq == null) return;
  const confirmed = await chat.askAction({
    kind: 'edit-question', itemId: props.item.id, seq,
    payload: {
      seq,
      message: next,
      documentIds: docs.filter((d) => keptDocs.value.has(d.id)).map((d) => d.id),
      removeDocumentIds: docs.filter((d) => !keptDocs.value.has(d.id)).map((d) => d.id),
      images: images.filter((_, i) => keptImages.value.has(i)).map(wire)
    }
  });
  if (confirmed) chat.beginEdit(null);
}

// Retry means "this question again", with every attachment it was asked with.
function retry() {
  const { seq, text: message, docs, images } = props.item;
  if (seq == null) return;
  chat.askAction({ kind: 'retry', itemId: props.item.id, seq, payload: { seq, message, documentIds: docs.map((d) => d.id), images: images.map(wire) } });
}
function fork() { if (props.item.seq != null) chat.askAction({ kind: 'fork', itemId: props.item.id, seq: props.item.seq, at: 'question' }); }
function remove() { if (props.item.seq != null) chat.askAction({ kind: 'delete-question', itemId: props.item.id, seq: props.item.seq }); }

async function copy() {
  try {
    await navigator.clipboard.writeText(props.item.text);
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 1500);
  } catch { /* clipboard blocked: nothing to say */ }
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); save(); }
}
</script>

<template>
  <div class="msg user" :class="{ editing }" :data-item="item.id">
    <div v-if="!editing" class="body">{{ item.text }}</div>
    <div v-if="!editing && item.docs.length" class="msg-attachments">
      <button v-for="(d, i) in item.docs" :key="d.id" type="button" class="attachment-chip" :title="`Open ${d.filename}`" @click="view('doc', i)"><Icon name="doc" size=".9rem" />{{ d.filename }}</button>
    </div>
    <div v-if="!editing && item.images.length" class="msg-images">
      <button v-for="(img, i) in item.images" :key="i" type="button" class="msg-image-btn" :title="`Open ${img.filename || 'image'}`" @click="view('image', i)">
        <img class="msg-image-thumb" :src="src(img)" :alt="img.filename || 'attached image'">
      </button>
    </div>
    <form v-if="editing" class="composer composer-inline" @submit.prevent="save" @dragover.prevent @dragenter.prevent
          @drop.prevent="bar?.stageAll($event.dataTransfer?.files)">
      <div v-if="item.docs.length || item.images.length" class="edit-artifacts">
        <button v-for="d in item.docs" :key="d.id" type="button" class="attachment-chip removable" :class="{ removed: !keptDocs.has(d.id) }"
                title="Click to drop this document from the resubmitted message" @click="toggle(keptDocs, d.id)">{{ d.filename }}</button>
        <button v-for="(img, i) in item.images" :key="i" type="button" class="attachment-chip attachment-chip-image removable"
                :class="{ removed: !keptImages.has(i) }" title="Click to drop this image from the resubmitted message" @click="toggle(keptImages, i)">
          <img class="attachment-thumb" :src="src(img)" :alt="img.filename || 'attached image'">
        </button>
      </div>
      <AttachmentTray lane="edit" />
      <textarea ref="area" v-model="text" class="composer-input" :rows="rows" aria-label="Edit question" @keydown="onKey" @paste="bar?.onPaste($event)" />
      <ComposerBar ref="bar" lane="edit">
        <button type="button" class="edit-cancel" @click="cancel">Cancel</button>
        <button type="submit" class="primary composer-send" :disabled="!text.trim()" aria-label="Resubmit" title="Resubmit (Enter)">
          <Icon name="send" />
        </button>
      </ComposerBar>
    </form>
    <!-- One that has not been saved yet (the one being sent right now) gets no controls. -->
    <div v-if="item.seq != null && !editing" class="msg-tools">
      <button type="button" class="icon-btn" :title="copied ? 'Copied' : 'Copy question'" aria-label="Copy question" @click="copy">
        <Icon :name="copied ? 'check' : 'copy'" size="1rem" /></button>
      <button type="button" class="icon-btn" title="Edit: rewrite this question and answer it again" aria-label="Edit question"
              :disabled="chat.busy" @click="beginEdit"><Icon name="edit" size="1rem" /></button>
      <button type="button" class="icon-btn" title="Retry: answer this question again from scratch" aria-label="Retry question"
              :disabled="chat.busy" @click="retry"><Icon name="retry" size="1rem" /></button>
      <button type="button" class="icon-btn" title="Fork: a new chat from here, listed under this one" aria-label="Fork from this question"
              :disabled="chat.busy" @click="fork"><Icon name="fork" size="1rem" /></button>
      <button type="button" class="icon-btn" title="Delete this question and everything after it" aria-label="Delete question"
              :disabled="chat.busy" @click="remove"><Icon name="trash" size="1rem" /></button>
    </div>
  </div>
</template>
