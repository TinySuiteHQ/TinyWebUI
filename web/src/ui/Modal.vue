<script setup lang="ts">
/** A native modal dialog, open for as long as it is mounted. Escape and the backdrop's cancel close it. */
import { onMounted, ref } from 'vue';

defineProps<{ labelledby: string }>();
const emit = defineEmits<{ close: [] }>();
const el = ref<HTMLDialogElement>();

onMounted(() => el.value?.showModal());
// The native close (Escape) must not also reach the page's Escape handling.
function onCancel(e: Event) { e.preventDefault(); emit('close'); }
</script>

<template>
  <dialog ref="el" :aria-labelledby="labelledby" @cancel="onCancel" @keydown.esc.stop>
    <slot />
  </dialog>
</template>
