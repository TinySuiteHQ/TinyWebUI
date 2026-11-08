<script setup lang="ts">
/**
 * The one place model-written text becomes HTML. renderMarkdown escapes
 * everything before it produces a tag (see core/md.ts and its tests), and a
 * test keeps v-html out of every other component.
 */
import { computed } from 'vue';
import { renderMarkdown } from '../core/md.ts';

const props = defineProps<{ text: string }>();
// Re-parsed only when the text changes: the chat store hands a streaming
// answer over once per frame, and a settled one never changes again.
const html = computed(() => renderMarkdown(props.text));
</script>

<template>
  <div class="md" v-html="html" />
</template>
