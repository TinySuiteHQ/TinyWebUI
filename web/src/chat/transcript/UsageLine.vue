<script setup lang="ts">
/** One round's usage, or a turn's total: tokens in and out, and what the cache did. */
import { computed } from 'vue';
import { tally, type RawUsage } from '../../../../shared/usage.ts';

const props = defineProps<{ raws: RawUsage[], label?: string }>();
const fmt = (n: number) => n.toLocaleString('en-US');

const text = computed(() => {
  const u = tally(props.raws);
  const bits: string[] = [];
  if (props.label) bits.push(props.label);
  bits.push(`${fmt(u.in)} in`, `${fmt(u.out)} out`);
  if (u.cached) bits.push(`${fmt(u.cached)} cached (${u.in ? Math.round((u.cached / u.in) * 100) : 0}%)`);
  if (u.written) bits.push(`${fmt(u.written)} written`);
  if (u.discount) bits.push(`cache saved ${u.discount.toFixed(4)}`);
  if (!u.cached && !u.written) bits.push(u.reported ? 'no cache hit' : 'cache not reported');
  // A round served by a different upstream has a cold cache through no fault
  // of the prefix, and this is the only place that shows.
  if (u.providers.length) bits.push(`via ${u.providers.join(' + ')}`);
  return bits.join(' · ');
});
// The raw usage objects, for when a provider reports something this does not read.
const raw = computed(() => JSON.stringify(props.raws, null, 2));
</script>

<template>
  <div class="usage" :title="raw">{{ text }}</div>
</template>
