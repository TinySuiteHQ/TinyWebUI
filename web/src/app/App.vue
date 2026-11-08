<script setup lang="ts">
/**
 * Who is asking decides what loads: a sign-in form, a waiting room, or the
 * app. Nothing of the app is mounted (or fetched) before that is known.
 */
import { onMounted, ref } from 'vue';
import { useSession } from '../stores/session.ts';
import { useTheme } from '../stores/theme.ts';
import LoginView from '../auth/LoginView.vue';
import WaitingRoom from '../auth/WaitingRoom.vue';
import AppShell from './AppShell.vue';

const session = useSession();
const phase = ref<'booting' | 'login' | 'gate' | 'ready'>('booting');

onMounted(async () => {
  useTheme().init();
  const me = await session.loadAccess();
  if (me.user && me.user.status !== 'approved') phase.value = 'gate';
  else if (me.authMode === 'multiuser' && !me.user) phase.value = 'login';
  else phase.value = 'ready';
});
</script>

<template>
  <div v-if="phase === 'booting'" class="boot" aria-busy="true" />
  <LoginView v-else-if="phase === 'login'" />
  <WaitingRoom v-else-if="phase === 'gate'" />
  <AppShell v-else />
</template>
