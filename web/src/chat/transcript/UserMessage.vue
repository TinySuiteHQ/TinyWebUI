<script setup lang="ts">
/**
 * A question the person asked: a bubble, with its attachments. One that is in
 * the store (it has a seq) can be edited in place or retried; either rewinds
 * the chat to it. Removing an attachment while editing is local until saved.
 */
import { computed, nextTick, ref } from 'vue';
import type { UserItem, Img } from '../../model/turn_model.ts';
import { useChat } from '../../stores/chat.ts';
import Icon from '../../ui/Icon.vue';

const props = defineProps<{ item: UserItem }>();
const chat = useChat();

const editing = ref(false);
const text = ref('');
const keptDocs = ref(new Set<string>());
const keptImages = ref(new Set<number>());
const area = ref<HTMLTextAreaElement>();

const src = (img: Img) => `data:${img.mime};base64,${img.dataBase64 ?? img.data}`;
const rows = computed(() => Math.min(12, text.value.split('\n').length + 1));
const wire = (img: Img) => ({ mime: img.mime, data: img.data ?? img.dataBase64 });

function beginEdit() {
  if (chat.busy) return;
  text.value = props.item.text;
  keptDocs.value = new Set(props.item.docs.map((d) => d.id));
  keptImages.value = new Set(props.item.images.map((_, i) => i));
  editing.value = true;
  nextTick(() => { area.value?.focus(); area.value?.setSelectionRange(text.value.length, text.value.length); });
}

function toggle<T>(set: Set<T>, v: T) { if (set.has(v)) set.delete(v); else set.add(v); }

function save() {
  const next = text.value.trim();
  if (!next) return;
  const { docs, images, seq } = props.item;
  const docsChanged = keptDocs.value.size !== docs.length;
  const imagesChanged = keptImages.value.size !== images.length;
  if (next === props.item.text && !docsChanged && !imagesChanged) { editing.value = false; return; }
  chat.rewind({
    seq,
    message: next,
    documentIds: docs.filter((d) => keptDocs.value.has(d.id)).map((d) => d.id),
    removeDocumentIds: docs.filter((d) => !keptDocs.value.has(d.id)).map((d) => d.id),
    images: images.filter((_, i) => keptImages.value.has(i)).map(wire)
  });
}

// Retry means "this question again", with every attachment it was asked with.
function retry() {
  const { seq, text: message, docs, images } = props.item;
  chat.rewind({ seq, message, documentIds: docs.map((d) => d.id), images: images.map(wire) });
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); editing.value = false; }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
}
</script>

<template>
  <div class="msg user" :class="{ editing }" :data-item="item.id">
    <div v-if="!editing" class="body">{{ item.text }}</div>
    <div v-if="!editing && item.docs.length" class="msg-attachments">
      <span v-for="d in item.docs" :key="d.id" class="attachment-chip"><Icon name="doc" size=".9rem" />{{ d.filename }}</span>
    </div>
    <div v-if="!editing && item.images.length" class="msg-images">
      <img v-for="(img, i) in item.images" :key="i" class="msg-image-thumb" :src="src(img)" :alt="img.filename || 'attached image'">
    </div>
    <div v-if="editing" class="edit-box">
      <div v-if="item.docs.length || item.images.length" class="edit-artifacts">
        <button v-for="d in item.docs" :key="d.id" type="button" class="attachment-chip removable" :class="{ removed: !keptDocs.has(d.id) }"
                title="Click to drop this document from the resubmitted message" @click="toggle(keptDocs, d.id)">{{ d.filename }}</button>
        <button v-for="(img, i) in item.images" :key="i" type="button" class="attachment-chip attachment-chip-image removable"
                :class="{ removed: !keptImages.has(i) }" title="Click to drop this image from the resubmitted message" @click="toggle(keptImages, i)">
          <img class="attachment-thumb" :src="src(img)" :alt="img.filename || 'attached image'">
        </button>
      </div>
      <textarea ref="area" v-model="text" :rows="rows" aria-label="Edit question" @keydown="onKey" />
      <div class="edit-actions">
        <button type="button" class="primary" @click="save">Save &amp; resubmit</button>
        <button type="button" @click="editing = false">Cancel</button>
      </div>
    </div>
    <!-- One that has not been saved yet (the one being sent right now) gets no controls. -->
    <div v-if="item.seq != null && !editing" class="msg-tools">
      <button type="button" class="icon-btn" title="Edit: rewrite this question and answer it again" aria-label="Edit question"
              :disabled="chat.busy" @click="beginEdit"><Icon name="edit" size="1rem" /></button>
      <button type="button" class="icon-btn" title="Retry: answer this question again from scratch" aria-label="Retry question"
              :disabled="chat.busy" @click="retry"><Icon name="retry" size="1rem" /></button>
    </div>
  </div>
</template>
