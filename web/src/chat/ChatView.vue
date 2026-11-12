<script setup lang="ts">
import { computed } from 'vue';
import { useChat } from '../stores/chat.ts';
import Transcript from './transcript/Transcript.vue';
import ChatDocs from './transcript/ChatDocs.vue';
import Outline from './transcript/Outline.vue';
import EmptyState from './transcript/EmptyState.vue';
import TaskCard from './composer/TaskCard.vue';
import Composer from './composer/Composer.vue';

const chat = useChat();
// The same title bar as Files and MCP, so the transcript has an edge to scroll under.
const title = computed(() => chat.model.chat.title || 'New chat');
</script>

<template>
  <div v-if="!chat.empty" class="panel-head chat-head"><h2 :title="title">{{ title }}</h2></div>
  <Transcript />
  <ChatDocs />
  <Outline />
  <EmptyState v-if="chat.empty" />
  <footer>
    <TaskCard />
    <Composer />
  </footer>
</template>
