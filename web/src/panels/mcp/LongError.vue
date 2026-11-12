<script setup lang="ts">
/**
 * An error from a server, which can be a whole stack or a launcher's stderr:
 * a short one is shown as is; a long one shows its first lines, with the rest
 * a tap away, so one failed server does not push every card below off screen.
 */
import { computed, ref } from 'vue';

const props = defineProps<{ text: string, mono?: boolean }>();
// About two lines on a phone.
const long = computed(() => props.text.length > 120 || props.text.split('\n').length > 2);
const open = ref(false);
</script>

<template>
  <details v-if="long" class="long-err" :class="{ mono }" @toggle="open = ($event.target as HTMLDetailsElement).open">
    <summary><span class="long-err-text">{{ text }}</span><span class="long-err-more">{{ open ? 'Hide details' : 'Show details' }}</span></summary>
  </details>
  <div v-else class="long-err" :class="{ mono }"><span class="long-err-text">{{ text }}</span></div>
</template>
