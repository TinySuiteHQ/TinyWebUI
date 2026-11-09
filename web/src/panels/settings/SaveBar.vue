<script setup lang="ts">
/**
 * The draft pages' one Save, at the foot of the page and only while there is
 * something to save: a Save that is always there says nothing about whether
 * anything changed. The draft is shared, so it counts edits on the other
 * draft pages too.
 */
import { useSettingsDraft } from './draft_store.ts';

const store = useSettingsDraft();
</script>

<template>
  <div v-if="store.dirty && !store.saveDisabled" class="save-bar">
    <span class="save-bar-text">Unsaved changes</span>
    <span v-if="store.saveMsg" class="save-bar-err" role="alert">{{ store.saveMsg }}</span>
    <button type="button" @click="store.reset()">Discard</button>
    <button type="button" class="primary" @click="store.save()">Save changes</button>
  </div>
</template>
