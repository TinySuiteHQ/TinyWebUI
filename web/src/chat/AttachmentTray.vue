<script setup lang="ts">
/** What is staged for the next message, as chips; removing one costs nothing, nothing has been uploaded. */
import { useAttachments, stagedName } from '../stores/attachments.ts';
import Icon from '../ui/Icon.vue';

const attachments = useAttachments();
</script>

<template>
  <div v-if="attachments.pending.length" id="attachments" class="attachments">
    <span v-for="a in attachments.pending" :key="a.key" class="attachment-chip"
          :class="{ 'attachment-chip-image': a.isImage, 'attachment-chip-error': a.error && !a.isImage }"
          :title="a.error ? `${stagedName(a)}: ${a.error}` : stagedName(a)">
      <img v-if="a.isImage && a.normalized" class="attachment-thumb" :src="`data:${a.normalized.mime};base64,${a.normalized.data}`" :alt="stagedName(a)">
      <span v-else-if="a.isImage" class="attachment-thumb" :class="a.error ? 'broken' : 'pending'" />
      <template v-else><Icon name="doc" size=".9rem" />{{ stagedName(a) }}</template>
      <button type="button" class="remove" :aria-label="`Remove ${stagedName(a)}`" @click="attachments.remove(a)">✕</button>
    </span>
  </div>
</template>
