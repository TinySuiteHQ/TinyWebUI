<script setup lang="ts">
/** A fresh chat: the mascot, a greeting, and the composer centred under it; started in a folder, it says which. */
import { computed } from 'vue';
import { useSession } from '../../stores/session.ts';
import { useChat } from '../../stores/chat.ts';
import { useChats } from '../../stores/chats.ts';
import Icon from '../../ui/Icon.vue';

const session = useSession();
const chat = useChat();
const chats = useChats();
const hour = new Date().getHours();
const greeting = computed(() => {
  const name = session.me.user?.name?.split(/\s+/)[0];
  const part = hour < 5 ? 'Up late' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  return name ? `${part}, ${name}` : part;
});
const folder = computed(() => (chat.draftFolder && chats.folders.includes(chat.draftFolder) ? chat.draftFolder : null));
</script>

<template>
  <div id="hello">
    <img class="hello-mascot" src="/favicon.svg" alt="" aria-hidden="true">
    <h2>{{ greeting }}</h2>
    <p v-if="!folder">Ask anything, or attach files to get started.</p>
    <div v-else class="hello-folder">
      <span class="hello-folder-name"><Icon name="folder" size=".95rem" />{{ folder }}</span>
      <span>{{ chats.prompts[folder] ? 'This chat goes in this folder and follows its instructions.' : 'This chat goes in this folder.' }}</span>
    </div>
  </div>
</template>
