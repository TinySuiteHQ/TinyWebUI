<script setup lang="ts">
/**
 * Signed in, not let in (yet): a page that says so and nothing else, instead
 * of an app whose every request would be refused. Re-checks on its own and
 * opens the app the moment an admin approves.
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { api } from '../core/api.ts';
import { useSession } from '../stores/session.ts';
import Icon from '../ui/Icon.vue';

// How often the waiting room asks whether an admin has let this person in.
const POLL_MS = 15_000;

const session = useSession();
const me = session.me;
const disabled = me.user?.status === 'disabled';
const who = me.user?.email || me.user?.name;
const note = ref('');
let timer: ReturnType<typeof setTimeout> | undefined;

async function check() {
  clearTimeout(timer);
  note.value = 'Checking…';
  let now = null;
  try { now = await api.get('/api/auth/me'); } catch { /* offline for a moment: try again later */ }
  if (now?.user && now.user.status !== me.user?.status) { location.reload(); return; }
  note.value = `Last checked ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  if (!disabled) timer = setTimeout(check, POLL_MS);
}

onMounted(() => { if (!disabled) timer = setTimeout(check, POLL_MS); });
onBeforeUnmount(() => clearTimeout(timer));
</script>

<template>
  <div id="gate" :class="{ off: disabled }">
    <div class="login-card gate-card" role="status" aria-live="polite">
      <div class="gate-icon" aria-hidden="true"><Icon name="clock" /></div>
      <h2>{{ disabled ? 'Access turned off' : 'Waiting for approval' }}</h2>
      <p class="gate-text">
        {{ disabled
          ? 'An administrator has turned off your access. If you think that is a mistake, ask them to turn it back on.'
          : 'Your account has been created. An administrator needs to approve it before you can start; this page opens by itself once they do.' }}
      </p>
      <p v-if="who" class="gate-who">Signed in as {{ who }}</p>
      <div class="gate-actions">
        <button v-if="!disabled" type="button" @click="check">Check now</button>
        <button v-if="session.canLogout" type="button" @click="session.logout()">Sign out</button>
      </div>
      <small v-if="note" class="usage">{{ note }}</small>
    </div>
  </div>
</template>
