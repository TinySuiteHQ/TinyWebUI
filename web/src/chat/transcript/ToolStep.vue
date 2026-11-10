<script setup lang="ts">
/** One tool call in the activity: its name and what it was on; the arguments and result unfold on demand. */
import { computed, ref } from 'vue';
import type { ToolStep } from '../../model/turn_model.ts';
import Icon from '../../ui/Icon.vue';

const props = defineProps<{ step: ToolStep }>();
const open = ref(false);
const name = computed(() => props.step.name.replace(/^[^_]+__/, ''));
const meta = computed(() => {
  const s = props.step;
  if (s.state === 'running') return 'running…';
  if (s.state === 'waiting') return 'waiting for you';
  if (s.state !== 'done') return s.state;
  // Under a tenth of a second is replayed events landing together, not a timing.
  return s.startedAt && s.endedAt && s.endedAt - s.startedAt >= 100 ? `${((s.endedAt - s.startedAt) / 1000).toFixed(1)}s` : '';
});
</script>

<template>
  <div class="tool-step" :class="[step.state, { bad: step.error, open }]">
    <button type="button" class="tool-step-head" :aria-expanded="open" @click="open = !open">
      <span class="tool-dot" aria-hidden="true" />
      <span class="name">{{ name }}</span>
      <span class="arg">{{ step.arg }}</span>
      <span v-if="step.compacted" class="chip" title="The model was sent a short stub; the full output is kept here">compacted</span>
      <span class="ms">{{ meta }}</span>
      <Icon class="chev" name="chevronRight" size=".875rem" />
    </button>
    <!-- Mounted only when opened: a long chat holds a lot of tool output nobody looks at. -->
    <div v-if="open" class="tool-step-body">
      <div class="tool-step-label">Arguments</div>
      <pre>{{ step.args }}</pre>
      <template v-if="step.result !== null">
        <div class="tool-step-label">Result</div>
        <pre>{{ step.result }}</pre>
      </template>
    </div>
  </div>
</template>
