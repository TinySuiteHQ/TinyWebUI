<script setup lang="ts">
/**
 * The one place model-written text becomes HTML. renderBlocks escapes
 * everything before it produces a tag (see core/md.ts and its tests), and a
 * test keeps v-html out of every other component.
 *
 * One element per top-level block, each rendered once: while an answer
 * streams only its last block changes, so a frame re-renders that block and
 * Vue leaves the DOM of the finished ones alone. The wrappers take no box of
 * their own (display: contents), so the blocks lay out as one flow.
 */
import { computed } from 'vue';
import { renderBlocks } from '../core/md.ts';

const props = defineProps<{ text: string }>();
const cache = new Map<string, string>();
const parts = computed(() => renderBlocks(props.text, cache));
</script>

<template>
  <div class="md">
    <div v-for="(html, i) in parts" :key="i" class="md-part" v-html="html" />
  </div>
</template>
