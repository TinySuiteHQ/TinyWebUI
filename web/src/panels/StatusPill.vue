<script setup lang="ts">
const props = defineProps<{ status?: string | null }>();
const LABEL: Record<string, string> = { completed: 'succeeded', failed: 'failed', running: 'running', queued: 'queued' };
const known = props.status ? LABEL[props.status] : undefined;
</script>

<template>
  <span class="automation-pill" :class="known ? `is-${status}` : status ? 'is-failed' : 'is-never'" :title="status && !known ? status : undefined">
    {{ known || status || 'never run' }}
  </span>
</template>
