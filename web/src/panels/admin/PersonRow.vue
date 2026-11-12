<script setup lang="ts">
/** One person on the People tab: who they are, and what can be done about them. */
import { computed, ref } from 'vue';
import { api } from '../../core/api.ts';
import { useSession } from '../../stores/session.ts';
import { ago, plural, roleLabel } from './admin_words.ts';
import type { AdminUsersReply, AdminUserView, UserStatusView } from '../../../../shared/api.ts';

const props = defineProps<{ user: AdminUsersReply['users'][number], roles: string[] }>();
const emit = defineEmits<{ changed: [user: AdminUserView], chats: [], connectors: [] }>();
const session = useSession();
const enc = encodeURIComponent;

const err = ref('');
const busy = ref(false);
const pendingRole = ref(props.user.role);
const pwOpen = ref(false);
const pw = ref('');
const pwAgain = ref('');
const pwMsg = ref('');
const pwDone = ref('');

const self = computed(() => session.me.user?.id === props.user.id);
// Your own account cannot be demoted or disabled from here -- the server
// refuses too, but a locked control says so before you try.
const locked = computed(() => self.value || Boolean(props.user.pinnedInCode));
const display = computed(() => props.user.name || props.user.email || 'this person');
const roleNames = computed(() => (props.roles.includes(props.user.role) ? props.roles : [...props.roles, props.user.role]));
const meta = computed(() => (props.user.status === 'pending'
  ? [props.user.name && props.user.email, `asked ${ago(props.user.createdAt)}`]
  : [props.user.name && props.user.email, plural(props.user.chatCount ?? 0, 'chat'), `seen ${ago(props.user.lastLoginAt)}`]).filter(Boolean).join(' · '));
const initial = computed(() => (props.user.name || props.user.email || '?').trim().charAt(0).toUpperCase() || '?');

async function patch(body: { role?: string, status?: UserStatusView }) {
  busy.value = true;
  err.value = '';
  try {
    const out = await api.patch<{ user: AdminUserView }>(`/api/admin/users/${enc(props.user.id)}`, body);
    emit('changed', out.user);
  } catch (e) { err.value = e.message; } finally { busy.value = false; }
}
function disable() {
  if (confirm(`Turn off access for ${display.value}? They are signed out at once; you can restore it later.`)) patch({ status: 'disabled' });
}

/**
 * An admin choosing a new password for someone who cannot sign in. Typed
 * twice, held to the same rule as every password; it signs them out everywhere.
 */
async function setPassword() {
  pwMsg.value = '';
  if (pw.value !== pwAgain.value) { pwMsg.value = 'The two passwords do not match.'; return; }
  try {
    await api.post(`/api/admin/users/${enc(props.user.id)}/password`, { password: pw.value });
    pwDone.value = `Password set. Let ${props.user.name || props.user.email || 'them'} know the new one; they were signed out.`;
    pw.value = pwAgain.value = '';
    setTimeout(() => { pwOpen.value = false; pwDone.value = ''; }, 6000);
  } catch (e) { pwMsg.value = e.message; }
}
</script>

<template>
  <div class="adm-person" :class="user.status">
    <span class="adm-avatar" aria-hidden="true">{{ initial }}</span>
    <div class="adm-who">
      <div class="adm-name">
        <strong>{{ user.name || user.email || user.id }}</strong>
        <span v-if="self" class="chip">you</span>
        <!-- Asked from the sign-in page: nobody vouches for the address, so the admin is told. -->
        <span v-if="user.status === 'pending' && user.hasPassword" class="chip"
              title="Requested access from the sign-in page. The email address is not checked: approve only people you expect.">asked to join</span>
        <span v-if="user.pinnedInCode" class="chip" :title="`Declared in tinywebui.config.js (${user.pinnedInCode}); change it there.`">set in config</span>
      </div>
      <span class="adm-meta">{{ meta }}</span>
      <!-- Their own words, as text: it comes from someone nobody has let in yet. -->
      <span v-if="user.note" class="adm-request-note">{{ user.note }}</span>
    </div>
    <div class="adm-actions" :title="locked ? (self ? 'This is your own account' : `Declared in code (${user.pinnedInCode})`) : undefined">
      <template v-if="user.status === 'pending'">
        <label class="adm-as" :for="`adm-role-${user.id}`">as</label>
        <select :id="`adm-role-${user.id}`" v-model="pendingRole" class="adm-role" :disabled="locked || busy" :aria-label="`Role for ${display}`">
          <option v-for="r in roleNames" :key="r" :value="r">{{ roles.includes(r) ? roleLabel(r) : `${r} (no longer defined)` }}</option>
        </select>
        <button type="button" class="primary" :disabled="locked || busy" @click="patch({ status: 'approved', role: pendingRole })">Approve</button>
        <button type="button" class="adm-quiet" :disabled="locked || busy" @click="patch({ status: 'disabled' })">Turn away</button>
      </template>
      <template v-else-if="user.status === 'disabled'">
        <span class="adm-meta">{{ roleLabel(user.role) }}</span>
        <button type="button" :disabled="locked || busy" @click="patch({ status: 'approved' })">Restore access</button>
      </template>
      <template v-else>
        <select class="adm-role" :value="user.role" :disabled="locked || busy" :aria-label="`Role for ${display}`"
                @change="patch({ role: ($event.target as HTMLSelectElement).value })">
          <option v-for="r in roleNames" :key="r" :value="r">{{ roles.includes(r) ? roleLabel(r) : `${r} (no longer defined)` }}</option>
        </select>
        <button type="button" class="adm-small" @click="emit('chats')">Chats</button>
        <button type="button" class="adm-small" @click="emit('connectors')">Connectors</button>
        <!-- Local accounts only: a gateway (SSO) account has no password here. Your own is under Settings → Account. -->
        <button v-if="user.hasPassword && !self" type="button" class="adm-small" @click="pwOpen = !pwOpen">Set password</button>
        <button type="button" class="adm-small adm-quiet" :disabled="locked || busy" @click="disable">Disable</button>
      </template>
    </div>
    <div v-if="err" class="adm-err" role="alert">{{ err }}</div>
    <form v-if="pwOpen" class="adm-pw" @submit.prevent="setPassword">
      <div v-if="pwDone" class="adm-meta adm-pw-done">{{ pwDone }}</div>
      <template v-else>
        <input v-model="pw" type="password" autocomplete="new-password" required :minlength="session.me.passwordMin" placeholder="New password" aria-label="New password">
        <input v-model="pwAgain" type="password" autocomplete="new-password" required :minlength="session.me.passwordMin" placeholder="Confirm new password" aria-label="Confirm new password">
        <button type="submit" class="primary">Set password</button>
        <button type="button" @click="pwOpen = false">Cancel</button>
        <div class="adm-meta adm-pw-rule">At least {{ session.me.passwordMin }} characters. {{ user.name || user.email || 'They' }} will be signed out everywhere.</div>
        <div v-if="pwMsg" class="adm-err" role="alert">{{ pwMsg }}</div>
      </template>
    </form>
  </div>
</template>
