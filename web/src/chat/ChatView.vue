<script setup lang="ts">
import { useChat } from '../stores/chat.ts';
import Transcript from './transcript/Transcript.vue';
import ChatDocs from './transcript/ChatDocs.vue';
import Outline from './transcript/Outline.vue';
import EmptyState from './transcript/EmptyState.vue';
import TaskCard from './composer/TaskCard.vue';
import AttachmentTray from './composer/AttachmentTray.vue';
import Composer from './composer/Composer.vue';

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
