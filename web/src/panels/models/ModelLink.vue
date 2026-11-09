<script setup lang="ts">
import type { ModelDraft } from './draft.ts';

defineProps<{ model: ModelDraft, isDefault: boolean }>();
const emit = defineEmits<{ open: [] }>();
</script>

<template>
  <button type="button" class="model-link" :class="{ off: !model.enabled }" @click="emit('open')">
    <span class="model-text">
      <span class="model-name">{{ model.label || model.id || 'Untitled model' }}</span>
      <span class="model-sub">{{ [model.model || model.id, model.enabled ? '' : 'disabled'].filter(Boolean).join(' · ') }}</span>
    </span>
    <!-- Only what is switched off: on is the default and says nothing. -->
    <span class="model-chips">
      <span v-if="isDefault" class="chip chip-default">default</span>
      <span v-if="!model.images" class="chip">no images</span>
      <span v-if="!model.tools" class="chip">no tools</span>
    </span>
    <span class="chev" aria-hidden="true">›</span>
  </button>
</template>
