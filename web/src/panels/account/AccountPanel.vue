<script setup lang="ts">
/**
 * Account: what is only this person's. Their own instructions (when an admin
 * lets people set them) and their password (local accounts only). Each saves
 * on its own; neither is part of the shared settings draft.
 */
import { computed, ref } from 'vue';
import { api } from '../../core/api.ts';
import { useSession } from '../../stores/session.ts';
import { useChat } from '../../stores/chat.ts';
import { PANEL } from '../../stores/panels.ts';
import { usePanel } from '../usePanel.ts';

const session = useSession();

const canInstruct = computed(() => Boolean(session.me.customize?.includes('instructions')));
const ownPassword = computed(() => Boolean(session.me.hasPassword));

/* ---------- instructions ---------- */

const instructions = ref('');
const savedInstructions = ref('');
const msg = ref('');
const busy = ref(false);
const dirty = computed(() => instructions.value.trim() !== savedInstructions.value.trim());

function loadInstructions() {
  savedInstructions.value = session.me.instructions || '';
  instructions.value = savedInstructions.value;
}

async function saveInstructions() {
  busy.value = true;
  msg.value = '';
  try {
    await api.post('/api/me/prefs', { instructions: instructions.value.trim() || null });
    await session.loadAccess();
    loadInstructions();
    msg.value = 'saved';
  } catch (err) { msg.value = `save failed (${err.message})`; } finally { busy.value = false; }
}

function canClose() {
  if (!dirty.value) return true;
  if (!window.confirm('Discard your unsaved instructions?')) return false;
  loadInstructions();
  return true;
}

/* ---------- password ---------- */

const pw = ref({ current: '', next: '', confirm: '' });
const pwMsg = ref('');
const pwOk = ref(false);
const pwBusy = ref(false);
async function changePassword() {
  pwMsg.value = '';
  pwOk.value = false;
  if (pw.value.next !== pw.value.confirm) { pwMsg.value = 'The two new passwords do not match.'; return; }
  pwBusy.value = true;
  try {
    await api.post('/api/me/password', { current: pw.value.current, password: pw.value.next });
    pw.value = { current: '', next: '', confirm: '' };
    pwMsg.value = 'Password changed. Your other sessions were signed out.';
    pwOk.value = true;
  } catch (err) { pwMsg.value = err.message; } finally { pwBusy.value = false; }
}

const { isOpen } = usePanel(PANEL.ACCOUNT, {
  onOpen: () => { msg.value = ''; pwMsg.value = ''; loadInstructions(); },
  onClose: ({ swapping }) => { if (!swapping) useChat().focusTick++; },
  canClose
});
</script>

<template>
  <section :id="PANEL.ACCOUNT" class="set-panel" :class="{ open: isOpen }" aria-label="Account">
    <div class="automation-head"><h2>Account</h2></div>
    <div class="settings-content">
      <form v-if="canInstruct" class="set-group mine" @submit.prevent="saveInstructions">
        <header><h3>My instructions</h3><p>Added after the system prompt on your chats only.</p></header>
        <textarea v-model="instructions" rows="5" maxlength="4000" aria-label="My instructions" />
        <div class="pw-actions"><button class="primary" type="submit" :disabled="busy || !dirty">Save instructions</button>
          <span class="pw-msg" :class="{ ok: msg === 'saved' }" role="status">{{ msg }}</span></div>
      </form>
      <!-- Local accounts only; behind a gateway (SSO) there is no password here to change. -->
      <form v-if="ownPassword" class="set-group mine" @submit.prevent="changePassword">
        <header><h3>Password</h3><p>At least {{ session.me.passwordMin }} characters. Changing it signs out your other sessions.</p></header>
        <!-- Tells password managers whose password this is; without it they guess, and fill the chat search. -->
        <input type="text" autocomplete="username" :value="session.me.user?.email || ''" hidden>
        <div class="set-grid">
          <div class="span-2"><label for="pwCurrent">Current password</label><input id="pwCurrent" v-model="pw.current" type="password" autocomplete="current-password" required></div>
          <div><label for="pwNew">New password</label><input id="pwNew" v-model="pw.next" type="password" autocomplete="new-password" :minlength="session.me.passwordMin || 0" required></div>
          <div><label for="pwConfirm">Confirm new password</label><input id="pwConfirm" v-model="pw.confirm" type="password" autocomplete="new-password" required></div>
        </div>
        <div class="pw-actions"><button class="primary" type="submit" :disabled="pwBusy">Change password</button>
          <span class="pw-msg" :class="{ ok: pwOk }" role="status">{{ pwMsg }}</span></div>
      </form>
    </div>
  </section>
</template>
