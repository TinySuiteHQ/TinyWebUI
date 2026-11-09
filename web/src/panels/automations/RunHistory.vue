<script setup lang="ts">
/** An automation's past runs, fetched on first open; each unfolds to what it produced, rendered as the chat would. */
import { ref } from 'vue';
import { api } from '../../core/api.ts';
import Markdown from '../../chat/Markdown.vue';
import { absolute } from './cron.ts';
import StatusPill from './StatusPill.vue';
import type { AutomationRunView } from '../../../../shared/api.ts';

const props = defineProps<{ automationId: string }>();
const emit = defineEmits<{ openChat: [] }>();
const runs = ref<AutomationRunView[] | null>(null);
const error = ref('');

async function onToggle(e: Event) {
  if (!(e.target as HTMLDetailsElement).open || runs.value) return;
  error.value = '';
  try { runs.value = (await api.get(`/api/automations/${encodeURIComponent(props.automationId)}/runs`)).runs || []; } catch (err) {
    // The next expand retries instead of leaving the section empty for good.
    error.value = `Couldn't load runs (${err.message}).`;
  }
}
const took = (r: AutomationRunView) => `${Math.max(1, Math.round(((r.finished_at ?? 0) - (r.started_at ?? 0)) / 1000))}s`;
</script>

<template>
  <details class="automation-history" @toggle="onToggle">
    <summary>Run history</summary>
    <p v-if="error">{{ error }}</p>
    <p v-else-if="runs && !runs.length">No runs yet.</p>
    <div v-else-if="runs" class="automation-runs">
      <details v-for="r in runs" :key="r.id" class="automation-run">
        <summary>
          <StatusPill :status="r.status" /><span>{{ absolute(r.scheduled_at) }}</span>
          <span class="muted">{{ r.trigger_type === 'manual' ? 'manual' : 'scheduled' }}</span>
          <span v-if="r.started_at && r.finished_at" class="muted">{{ took(r) }}</span>
        </summary>
        <div class="automation-run-body">
          <p v-if="r.error" class="automation-run-error">{{ r.error }}</p>
          <div v-if="r.result" class="automation-run-output"><Markdown :text="r.result" /></div>
          <p v-else-if="!r.error" class="muted">{{ r.status === 'running' || r.status === 'queued' ? 'Still running…' : 'No output recorded.' }}</p>
          <button type="button" class="link" @click="emit('openChat')">Open in chat →</button>
        </div>
      </details>
    </div>
  </details>
</template>
