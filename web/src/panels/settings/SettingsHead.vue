<script setup lang="ts">
/** The header of each page that edits the settings draft: its title, what the draft says, and the one Save. */
import { useSettingsDraft } from './draft_store.ts';

defineProps<{ title: string, back?: boolean }>();
const emit = defineEmits<{ back: [] }>();
const store = useSettingsDraft();
</script>

<template>
  <div class="automation-head">
    <button v-if="back" type="button" class="set-back" aria-label="Back" @click="emit('back')">‹ Back</button>
    <h2>{{ title }}</h2>
    <span class="usage">{{ store.saveMsg || store.baseMsg }}</span>
    <!-- No Close of its own: the dialog's close asks the page first (canClose), so unsaved edits still hold it. -->
    <button class="primary" type="button" :disabled="store.saveDisabled" @click="store.save()">Save changes</button>
  </div>
</template>
