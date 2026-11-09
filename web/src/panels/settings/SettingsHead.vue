<script setup lang="ts">
/** The header of each page that edits the settings draft: its title and what the draft says. Save lives in SaveBar. */
import { computed } from 'vue';
import { useSettingsDraft } from './draft_store.ts';

defineProps<{ title: string, back?: boolean }>();
const emit = defineEmits<{ back: [] }>();
const store = useSettingsDraft();
// While edits are pending the save bar speaks (including a failed save); a "Saved" only once there is nothing left.
const status = computed(() => (store.dirty ? '' : store.saveMsg || store.baseMsg));
</script>

<template>
  <div class="panel-head">
    <button v-if="back" type="button" class="set-back" aria-label="Back" @click="emit('back')">‹ Back</button>
    <h2>{{ title }}</h2>
    <span class="head-status" role="status">{{ status }}</span>
  </div>
</template>
