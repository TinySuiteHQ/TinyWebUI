<script setup lang="ts">
/** A fresh chat: the mascot, a greeting, and the composer centred under it. */
import { computed } from 'vue';
import { useSession } from '../../stores/session.ts';

const session = useSession();
const hour = new Date().getHours();
const greeting = computed(() => {
  const name = session.me.user?.name?.split(/\s+/)[0];
  const part = hour < 5 ? 'Up late' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  return name ? `${part}, ${name}` : part;
});
</script>

<template>
  <div id="hello">
    <img class="hello-mascot" src="/favicon.svg" alt="" aria-hidden="true">
    <h2>{{ greeting }}</h2>
    <p>Ask anything, or attach files to get started.</p>
  </div>
</template>
