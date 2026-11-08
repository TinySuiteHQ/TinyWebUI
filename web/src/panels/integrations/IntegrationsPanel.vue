<script setup lang="ts">
/**
 * Every connected MCP server, and for those that offer one, their management
 * views. What a person may open was decided server side; a view they cannot
 * use arrives with `available: false` and the reason, shown as is.
 */
import { computed, ref } from 'vue';
import { api } from '../core/api.ts';
import { PANEL } from '../stores/panels.ts';
import { usePanel } from './usePanel.ts';
import IntegrationView from './IntegrationView.vue';

// /api/integrations, read field by field.
type Json = any;
const ICON: Record<string, string> = { memory: '◎', search: '⌕', database: '▤', globe: '◍', tool: '⚒', plug: '⏚' };
// TinySuite's own servers get their mark, shipped with the page; the id only
// picks one of these files, so a server still supplies no markup or URL.
const LOGO: Record<string, string> = { tinycontext: '/icons/tinycontext.svg', tinysearch: '/icons/tinysearch.svg' };
const enc = encodeURIComponent;

const state = ref<{ servers: Json[], multiUser: boolean }>({ servers: [], multiUser: false });
const loading = ref(false);
const error = ref('');
const current = ref<{ server: string, view: string } | null>(null);
let seq = 0;

const server = computed(() => (current.value ? state.value.servers.find((s) => s.name === current.value?.server) : null));
const view = computed(() => server.value?.manifest?.views.find((v: Json) => v.id === current.value?.view));

async function load() {
  const mine = ++seq;
  loading.value = true;
  try {
    const data = await api.get('/api/integrations');
    if (mine !== seq) return;
    state.value = data;
    error.value = '';
    if (current.value && !state.value.servers.some((s) => s.name === current.value?.server)) current.value = null;
  } catch (err) {
    if (mine === seq) error.value = err.message;
  } finally {
    if (mine === seq) loading.value = false;
  }
}

function open(name: string) {
  const s = state.value.servers.find((x) => x.name === name);
  if (!s?.manifest) return;
  const first = s.manifest.views.find((v: Json) => v.available) || s.manifest.views[0];
  current.value = { server: name, view: first.id };
}
const logo = (m: Json) => (m && Object.hasOwn(LOGO, m.id) ? LOGO[m.id] : null);
const meta = (s: Json) => [s.name !== s.manifest?.title ? s.name : null, s.manifest?.version ? `v${s.manifest.version}` : null,
  `${s.tools} tool${s.tools === 1 ? '' : 's'}`].filter(Boolean).join(' · ');

// Re-read on every open: what a server offers can change between visits.
const { isOpen } = usePanel(PANEL.INTEGRATIONS, { onOpen: load });
</script>

<template>
  <section id="integrations" :class="{ open: isOpen }" aria-label="Integrations">
    <div class="automation-head">
      <button v-if="current" type="button" class="set-back" @click="current = null; load()">‹ All</button>
      <h2>{{ server?.manifest?.title || current?.server || 'Integrations' }}</h2>
    </div>
    <div class="statistics-content">
      <p v-if="error" class="int-error">{{ error }}</p>
      <template v-else-if="server && view">
        <div class="int-tabs" role="tablist">
          <button v-for="v in server.manifest.views" :key="v.id" type="button" role="tab" :aria-selected="v.id === view.id"
                  :class="{ active: v.id === view.id, off: !v.available }" @click="current = { server: server.name, view: v.id }">{{ v.title }}</button>
        </div>
        <div v-if="!view.available" class="int-view"><p class="int-notice">{{ view.reason || 'Not available to you.' }}</p></div>
        <IntegrationView v-else :key="`${server.name}/${view.id}`" :view="view" :base="`/api/integrations/${enc(server.name)}/views/${enc(view.id)}`" />
      </template>
      <p v-else-if="loading && !state.servers.length" class="empty">Loading…</p>
      <p v-else-if="!state.servers.length" class="empty">No MCP servers are connected.</p>
      <template v-else>
        <section v-for="s in state.servers" :key="s.name" class="statistics-block int-card">
          <div class="int-head">
            <img v-if="logo(s.manifest)" class="int-icon int-logo" :src="logo(s.manifest) ?? undefined" alt="">
            <span v-else class="int-icon">{{ ICON[s.manifest?.icon] || ICON.plug }}</span>
            <div class="int-name"><h3>{{ s.manifest?.title || s.name }}</h3><span class="usage">{{ meta(s) }}</span></div>
            <span class="int-chips">
              <span class="chip" :class="s.status === 'ok' ? 'chip-ok' : 'chip-bad'">{{ s.status === 'ok' ? 'connected' : s.status }}</span>
              <span v-if="state.multiUser" class="chip">{{ s.perUser ? 'per person' : 'shared by everyone' }}</span>
            </span>
          </div>
          <p v-if="s.manifest?.description" class="int-desc">{{ s.manifest.description }}</p>
          <p v-if="s.error" class="int-error">{{ s.error }}</p>
          <p v-if="s.manageError" class="int-error">Management page unavailable: {{ s.manageError }}</p>
          <button v-if="s.manifest?.views.length" type="button" class="primary" @click="open(s.name)">Manage</button>
          <p v-else-if="s.status === 'ok' && !s.manageError" class="usage">Its tools work in chats; it offers no management page.</p>
        </section>
      </template>
    </div>
  </section>
</template>
