<script setup lang="ts">
/**
 * A native modal dialog, open for as long as it is mounted. Escape and the
 * backdrop's cancel close it. Given a `title`, it is a card: an icon, the
 * title and a line under it, and a close button, over the slot; the slot then
 * holds the body (`.modal-body`) and its `.dialog-actions` footer. Without
 * one, the slot draws everything (the camera, the library, settings).
 */
import { onMounted, ref } from 'vue';
import Icon from './Icon.vue';

defineProps<{ labelledby: string, title?: string, subtitle?: string, icon?: string, danger?: boolean }>();
const emit = defineEmits<{ close: [] }>();
const el = ref<HTMLDialogElement>();

onMounted(() => el.value?.showModal());
// The native close (Escape) must not also reach the page's Escape handling.
function onCancel(e: Event) { e.preventDefault(); emit('close'); }
</script>

<template>
  <dialog ref="el" :class="{ 'modal-card': title, 'modal-danger': danger }" :aria-labelledby="labelledby" @cancel="onCancel" @keydown.esc.stop>
    <header v-if="title" class="modal-head">
      <span v-if="icon" class="modal-icon" aria-hidden="true"><Icon :name="icon" size="1.125rem" /></span>
      <div class="modal-titles">
        <h2 :id="labelledby">{{ title }}</h2>
        <p v-if="subtitle" class="modal-sub">{{ subtitle }}</p>
      </div>
      <button type="button" class="icon-btn modal-close" aria-label="Close" title="Close" @click="emit('close')">
        <Icon name="x" size="1rem" />
      </button>
    </header>
    <slot />
  </dialog>
</template>
