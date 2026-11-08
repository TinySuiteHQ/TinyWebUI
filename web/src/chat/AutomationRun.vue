<script setup lang="ts">
/**
 * The turn an automation run starts with. The model got the full run message;
 * the reader gets which automation ran and why, its prompt folded away. No
 * edit or retry: nobody typed it.
 */
import { computed } from 'vue';
import type { AutomationOrigin } from './turn-model.ts';
import Icon from '../ui/Icon.vue';

const props = defineProps<{ origin: AutomationOrigin }>();
const meta = computed(() => [
  props.origin.trigger === 'manual' ? 'run manually' : 'scheduled run',
  props.origin.cron && `${props.origin.cron}${props.origin.timezone ? ` (${props.origin.timezone})` : ''}`
].filter(Boolean).join(' · '));
</script>

<template>
  <div class="msg automation-run">
    <div class="automation-run-head">
      <Icon name="automations" size="1rem" />
      <span class="automation-run-name">{{ origin.name || 'Automation' }}</span>
      <span class="automation-run-meta">{{ meta }}</span>
    </div>
    <details v-if="origin.prompt" class="automation-run-prompt">
      <summary>What it was asked to do</summary>
      <div class="body">{{ origin.prompt }}</div>
    </details>
  </div>
</template>
