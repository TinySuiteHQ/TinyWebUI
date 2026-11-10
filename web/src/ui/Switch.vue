<script setup lang="ts">
/** An on/off switch. `toggle(next)` returns a promise; the switch holds still until it settles. */
import { ref } from 'vue';

const props = defineProps<{ on: boolean, label: string, readOnly?: boolean, toggle: (next: boolean) => Promise<unknown> }>();
const emit = defineEmits<{ error: [message: string] }>();
const busy = ref(false);

async function flip(e: Event) {
  e.stopPropagation();
  e.preventDefault();
  busy.value = true;
  try { await props.toggle(!props.on); } catch (err) { emit('error', err.message); } finally { busy.value = false; }
}
</script>

<template>
  <button type="button" class="switch" role="switch" :aria-checked="on" :aria-label="label"
          :disabled="busy || readOnly" :title="readOnly ? 'Managed by your administrator' : undefined" @click="flip" />
</template>
