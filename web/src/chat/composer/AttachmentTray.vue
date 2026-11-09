<script setup lang="ts">
/** What is staged for the next message (or the question being edited), as chips; removing one costs nothing, nothing has been uploaded. */
import { computed } from 'vue';
import { useAttachments, stagedName, type Lane } from '../../stores/attachments.ts';
import Icon from '../../ui/Icon.vue';

const props = withDefaults(defineProps<{ lane?: Lane }>(), { lane: 'compose' });
const attachments = useAttachments();
const staged = computed(() => (props.lane === 'edit' ? attachments.editing : attachments.pending));
</script>

<template>
  <div v-if="staged.length" :id="lane === 'compose' ? 'attachments' : undefined" class="attachments">
    <span v-for="a in staged" :key="a.key" class="attachment-chip"
          :class="{ 'attachment-chip-image': a.isImage, 'attachment-chip-error': a.error && !a.isImage }"
          :title="a.error ? `${stagedName(a)}: ${a.error}` : stagedName(a)">
      <img v-if="a.isImage && a.normalized" class="attachment-thumb" :src="`data:${a.normalized.mime};base64,${a.normalized.data}`" :alt="stagedName(a)">
      <span v-else-if="a.isImage" class="attachment-thumb" :class="a.error ? 'broken' : 'pending'" />
      <template v-else><Icon name="doc" size=".9rem" />{{ stagedName(a) }}</template>
      <button type="button" class="remove" :aria-label="`Remove ${stagedName(a)}`" @click="attachments.remove(a, lane)">✕</button>
    </span>
  </div>
</template>
