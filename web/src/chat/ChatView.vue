<script setup lang="ts">
import { useChat } from '../stores/chat.ts';
import Transcript from './Transcript.vue';
import ChatDocs from './ChatDocs.vue';
import Outline from './Outline.vue';
import EmptyState from './EmptyState.vue';
import TaskCard from './TaskCard.vue';
import AttachmentTray from './AttachmentTray.vue';
import Composer from './Composer.vue';

const chat = useChat();
</script>

<template>
  <Transcript />
  <ChatDocs />
  <Outline />
  <EmptyState v-if="chat.empty" />
  <footer>
    <TaskCard />
    <AttachmentTray />
    <Composer />
  </footer>
</template>
