<script setup lang="ts">
/**
 * Local auth with no session: sign in, claim a fresh install, accept an
 * invite, or ask for an account. A request makes a pending account; signing
 * in to it lands in the waiting room, which opens the app once approved.
 */
import { computed, nextTick, onMounted, ref } from 'vue';
import { api } from '../core/api.ts';
import { useSession } from '../stores/session.ts';

type Mode = 'setup' | 'join' | 'signin' | 'request';
const TEXT: Record<Mode, { title: string, help: string, submit: string }> = {
  setup: { title: 'Create the administrator', help: 'The first account owns this installation and can invite others.', submit: 'Create administrator' },
  join: { title: 'Join TinyWebUI', help: 'Create your account using this invitation.', submit: 'Create account' },
  signin: { title: 'TinyWebUI', help: '', submit: 'Sign in' },
  request: { title: 'Request access', help: 'An administrator approves each request before you can start.', submit: 'Send request' }
};

const me = useSession().me;
const invite = new URLSearchParams(location.search).get('invite');
if (invite) history.replaceState(null, '', location.pathname);

const mode = ref<Mode>(me.needsSetup && !invite ? 'setup' : invite ? 'join' : 'signin');
const email = ref('');
const password = ref('');
const confirm = ref('');
const note = ref('');
const msg = ref('');
const busy = ref(false);
const emailEl = ref<HTMLInputElement>();
const passwordEl = ref<HTMLInputElement>();
const confirmEl = ref<HTMLInputElement>();

const creating = computed(() => mode.value !== 'signin');
// Only between signing in and asking: setup and invitations have one way through.
const other = computed<Mode | null>(() => (mode.value === 'signin' && me.canRequest ? 'request' : mode.value === 'request' ? 'signin' : null));

function show(next: Mode, text = '') {
  mode.value = next;
  msg.value = text;
  nextTick(() => emailEl.value?.focus());
}
function switchMode() {
  if (!other.value) return;
  show(other.value);
  password.value = confirm.value = '';
}

const signIn = () => api.post('/api/auth/login', { email: email.value, password: password.value });

async function submit() {
  msg.value = '';
  if (creating.value && password.value !== confirm.value) {
    msg.value = 'The two passwords do not match.';
    confirmEl.value?.select();
    return;
  }
  const account = { email: email.value, password: password.value };
  busy.value = true;
  try {
    if (mode.value === 'setup') await api.post('/api/auth/setup', account);
    else if (mode.value === 'join') await api.post('/api/auth/accept-invite', { ...account, token: invite });
    else if (mode.value === 'signin') await signIn();
    else {
      await api.post('/api/auth/request-access', { ...account, note: note.value.trim() || null });
      // Straight into the waiting room. The server says "sent" even for an
      // address that already has an account; then this sign-in fails, and the
      // page says no more than that the request went out.
      try { await signIn(); } catch {
        show('signin', 'Request sent. Once an administrator approves it, sign in with that email and password.');
        return;
      }
    }
    if (mode.value === 'join') location.href = location.pathname;
    else location.reload();
  } catch (err) {
    msg.value = err.message;
    if (mode.value === 'signin') passwordEl.value?.select();
  } finally {
    busy.value = false;
  }
}

onMounted(() => emailEl.value?.focus());
</script>

<template>
  <div id="login">
    <form class="login-card" @submit.prevent="submit">
      <img class="login-logo" src="/favicon.svg" alt="" aria-hidden="true">
      <h2>{{ TEXT[mode].title }}</h2>
      <div v-if="TEXT[mode].help" class="usage">{{ TEXT[mode].help }}</div>
      <label for="loginEmail">Email</label>
      <input id="loginEmail" ref="emailEl" v-model="email" type="email" autocomplete="email" required>
      <label for="loginPassword">Password</label>
      <input id="loginPassword" ref="passwordEl" v-model="password" type="password" required
             :autocomplete="creating ? 'new-password' : 'current-password'"
             :minlength="creating && me.passwordMin ? me.passwordMin : undefined">
      <!-- A new password is typed twice, and the rule is said before the server has to. -->
      <template v-if="creating">
        <small v-if="me.passwordMin" class="login-rule">At least {{ me.passwordMin }} characters.</small>
        <label for="loginConfirm">Confirm password</label>
        <input id="loginConfirm" ref="confirmEl" v-model="confirm" type="password" autocomplete="new-password" required>
      </template>
      <template v-if="mode === 'request'">
        <label for="loginNote">Note to the administrator <span class="login-optional">(optional)</span></label>
        <textarea id="loginNote" v-model="note" rows="3" maxlength="500" placeholder="Who you are, or why you need access" />
      </template>
      <button class="primary" type="submit" :disabled="busy">{{ TEXT[mode].submit }}</button>
      <div v-if="msg" class="usage login-msg" role="alert">{{ msg }}</div>
      <p v-if="other" class="login-switch">
        {{ other === 'request' ? "Don't have an account?" : 'Already have one?' }}
        <button type="button" class="link" @click="switchMode">{{ other === 'request' ? 'Request access' : 'Sign in' }}</button>
      </p>
    </form>
  </div>
</template>
