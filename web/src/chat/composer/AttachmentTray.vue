<script setup lang="ts">
/**
 * What is staged for the next message (or the question being edited), as cards
 * inside the box: an image as its thumbnail, anything else as its type's icon,
 * name and type. Removing one costs nothing, nothing has been uploaded.
 */
import { computed } from 'vue';
import { useAttachments, stagedName, type Lane, type Staged } from '../../stores/attachments.ts';
import { fileKind } from '../../core/file_kind.ts';
import Icon from '../../ui/Icon.vue';

const props = withDefaults(defineProps<{ lane?: Lane }>(), { lane: 'compose' });
const attachments = useAttachments();
const staged = computed(() => (props.lane === 'edit' ? attachments.editing : attachments.pending));

function size(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
const detail = (a: Staged) => a.error || [fileKind(stagedName(a)).label, a.file ? size(a.file.size) : ''].filter(Boolean).join(' · ');
</script>

<template>
  <div v-if="staged.length" :id="lane === 'compose' ? 'attachments' : undefined" class="attachments">
    <div v-for="a in staged" :key="a.key" class="attachment-card"
         :class="{ 'attachment-card-image': a.isImage, 'attachment-card-error': !!a.error }"
         :title="a.error ? `${stagedName(a)}: ${a.error}` : stagedName(a)">
      <img v-if="a.isImage && a.normalized" class="attachment-thumb" :src="`data:${a.normalized.mime};base64,${a.normalized.data}`" :alt="stagedName(a)">
      <span v-else-if="a.isImage" class="attachment-thumb" :class="a.error ? 'broken' : 'pending'" />
      <template v-else>
        <span class="attachment-card-icon" :data-kind="fileKind(stagedName(a)).icon"><Icon :name="fileKind(stagedName(a)).icon" /></span>
        <span class="attachment-card-text">
          <span class="attachment-card-name">{{ stagedName(a) }}</span>
          <span class="attachment-card-detail">{{ detail(a) }}</span>
        </span>
      </template>
      <button type="button" class="attachment-remove" :aria-label="`Remove ${stagedName(a)}`" @click="attachments.remove(a, lane)">
        <Icon name="x" />
      </button>
    </div>
  </div>
</template>
