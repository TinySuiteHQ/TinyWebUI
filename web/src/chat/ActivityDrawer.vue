<script setup lang="ts">
/**
 * Everything the agent did for a turn, behind one row. While it works with
 * nothing to read yet, the row is the live status line ("Searching…"); once
 * the answer starts, it settles into a recap ("Activity · 3 tools · 4.2s").
 * The body -- reasoning, tool calls, narration, per-round usage -- is mounted
 * only while open.
 */
import { computed, ref } from 'vue';
import type { Turn } from './turn-model.ts';
import ToolStep from './ToolStep.vue';
import UsageLine from './UsageLine.vue';
import Markdown from './Markdown.vue';
import Icon from '../ui/Icon.vue';

const props = defineProps<{ turn: Turn }>();
const open = ref(false);

const working = computed(() => !props.turn.done);
/** The live status takes the row only while there is nothing else to read. */
const live = computed(() => working.value && !props.turn.answer.trim());
const tools = computed(() => props.turn.activity.filter((e) => e.kind === 'tool').length);
const steps = computed(() => props.turn.activity.filter((e) => e.kind !== 'usage').length);

// A duration under a tenth of a second is replayed events landing together
// (a rejoin, a reload), not a real timing: it says nothing.
const secs = (a: number | null, b: number | null) => (a && b && b - a >= 100 ? `${((b - a) / 1000).toFixed(1)}s` : '');
const thoughtLabel = (e: { startedAt: number | null, endedAt: number | null }) => {
  if (!e.endedAt && working.value) return 'Thinking…';
  const took = secs(e.startedAt, e.endedAt);
  return took ? `Thought for ${took}` : 'Reasoning';
};
const recap = computed(() => {
  const t = props.turn;
  const bits: string[] = [];
  if (tools.value) bits.push(`${tools.value} tool${tools.value === 1 ? '' : 's'}`);
  const thoughts = t.activity.filter((e) => e.kind === 'reasoning');
  if (thoughts.length && !tools.value) bits.push('reasoning');
  const notes = t.activity.filter((e) => e.kind === 'note').length;
  if (notes && !tools.value && !thoughts.length) bits.push(`${notes} note${notes === 1 ? '' : 's'}`);
  // Elapsed time is real only for a turn that was watched.
  const took = secs(t.startedAt, t.finishedAt);
  if (took) bits.push(took);
  return bits.join(' · ');
});
</script>

<template>
  <div class="activity" :class="{ open, live, working }">
    <button type="button" class="activity-row" :aria-expanded="open" :disabled="!steps"
            :aria-label="live ? `${turn.status || 'Working'} — show activity` : 'Show activity'" @click="open = !open">
      <template v-if="live">
        <span class="status-dot" aria-hidden="true" />
        <span class="status-line" role="status" aria-live="polite">{{ turn.status || 'Working…' }}</span>
        <span v-if="steps" class="activity-count">{{ steps }} step{{ steps === 1 ? '' : 's' }}</span>
      </template>
      <template v-else>
        <span v-if="working" class="status-dot small" aria-hidden="true" />
        <Icon v-else name="sparkle" size=".95rem" />
        <span class="activity-label">Activity</span>
        <span class="activity-count">{{ recap }}</span>
      </template>
      <Icon v-if="steps" class="chev" name="chevronRight" size=".875rem" />
    </button>
    <div v-if="open" class="activity-body">
      <template v-for="e in turn.activity" :key="e.id">
        <details v-if="e.kind === 'reasoning'" class="thought" :open="!e.endedAt && working">
          <summary>{{ thoughtLabel(e) }}</summary>
          <div class="thought-body">{{ e.text }}</div>
        </details>
        <ToolStep v-else-if="e.kind === 'tool'" :step="e" />
        <div v-else-if="e.kind === 'note'" class="activity-note"><Markdown :text="e.text" /></div>
        <UsageLine v-else :raws="[e.raw]" />
      </template>
    </div>
  </div>
</template>
