<script setup lang="ts">
/**
 * MCP: every connected server on one page in the main column. Each card shows
 * what the server is and whether it is up, opens its management views (what a
 * person may open was decided server side), and, for whoever manages the
 * servers, its tools with their switches and approval. The raw config file
 * and the global approval mode sit in the header for them too.
 */
import { computed, ref, watch } from 'vue';
import { api } from '../../core/api.ts';
import { FEATURE } from '../../../../shared/features.ts';
import { useConfig } from '../../stores/config.ts';
import { useSession } from '../../stores/session.ts';
import { useChat } from '../../stores/chat.ts';
import { PANEL } from '../../stores/panels.ts';
import { usePanel } from '../usePanel.ts';
import { TOOL_APPROVALS } from '../settings/draft.ts';
import { onCount, useToolActions } from './tool_actions.ts';
import IntegrationView from './IntegrationView.vue';
import ServerTools from './ServerTools.vue';
import ToolRow from './ToolRow.vue';

// /api/integrations and /api/tools, read field by field.
type Json = any;
const ICON: Record<string, string> = { memory: '◎', search: '⌕', database: '▤', globe: '◍', tool: '⚒', plug: '⏚' };
// TinySuite's own servers get their mark, shipped with the page; the id only
// picks one of these files, so a server still supplies no markup or URL.
const LOGO: Record<string, string> = { tinycontext: '/icons/tinycontext.svg', tinysearch: '/icons/tinysearch.svg' };
const enc = encodeURIComponent;

const config = useConfig();
const session = useSession();
const { toggleTool, setApproval, defaultApproval } = useToolActions();

const manages = computed(() => session.can(FEATURE.MCP));
const usesViews = computed(() => session.can(FEATURE.INTEGRATIONS));

/* ---------- the server list: management views and tools, merged by name ---------- */

const state = ref<{ servers: Json[], multiUser: boolean }>({ servers: [], multiUser: false });
const loading = ref(false);
const error = ref('');
let seq = 0;

async function loadIntegrations() {
  if (!usesViews.value) return;
  const mine = ++seq;
  loading.value = true;
  try {
    const data = await api.get('/api/integrations');
    if (mine !== seq) return;
    state.value = data;
    error.value = '';
    if (current.value && !state.value.servers.some((s) => s.name === current.value?.server)) page.value = { kind: 'list' };
  } catch (err) {
    if (mine === seq) error.value = err.message;
  } finally {
    if (mine === seq) loading.value = false;
  }
}

const toolData = computed<Json | null>(() => (manages.value ? config.tools : null));
const cards = computed(() => {
  const byTools = new Map<string, Json>((toolData.value?.servers || []).map((s: Json) => [s.name, s]));
  const byViews = new Map<string, Json>(state.value.servers.map((s) => [s.name, s]));
  const names = [...new Set([...byTools.keys(), ...byViews.keys()])];
  return names.map((name) => ({ name, info: byViews.get(name) || null, tools: byTools.get(name) || null }));
});
const builtins = computed<Json[]>(() => toolData.value?.internal || []);

/*
 * Three tiers: built into TinyWebUI, bundled with it (the TinySuite servers,
 * whose Manage pages show what each keeps, did and failed), and whatever
 * someone added after. Which servers are bundled is the server's call, read
 * off the package each runs from, not the name it was given.
 */
type Card = { name: string, info: Json, tools: Json };
const isBundled = (c: Card) => Boolean(c.tools?.bundled ?? c.info?.bundled);
const tiers = computed(() => [
  { id: 'bundled', title: 'Bundled with insights', note: 'Shipped with TinyWebUI. Manage opens what each one keeps, did and failed.', cards: cards.value.filter(isBundled) },
  { id: 'third-party', title: 'Third-party', note: 'Servers added in the config file. Manage appears only if the server offers it.', cards: cards.value.filter((c) => !isBundled(c)) }
  // Whoever manages the servers always sees where an added one would go.
].filter((t) => t.cards.length || (t.id === 'third-party' && manages.value)));

const status = (c: Card) => c.tools?.status || c.info?.status || 'error';
// The marks are TinySuite's, so only a bundled server gets one: a manifest id alone could claim it.
const logo = (c: Card) => {
  const m = c.info?.manifest;
  return isBundled(c) && m && Object.hasOwn(LOGO, m.id) ? LOGO[m.id] : null;
};
const meta = (c: Card) => {
  const m = c.info?.manifest;
  const count = c.tools ? c.tools.tools.length : c.info?.tools;
  return [m?.title && c.name !== m.title ? c.name : null, m?.version ? `v${m.version}` : null,
    count != null ? `${count} tool${count === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ');
};

/* ---------- which page: the list, one server's views, or the config file ---------- */

type View = { kind: 'list' } | { kind: 'manage', server: string, view: string } | { kind: 'config' };
const page = ref<View>({ kind: 'list' });
const current = computed(() => (page.value.kind === 'manage' ? page.value : null));
const server = computed(() => (current.value ? state.value.servers.find((s) => s.name === current.value?.server) : null));
const view = computed(() => server.value?.manifest?.views.find((v: Json) => v.id === current.value?.view));
const title = computed(() => {
  if (page.value.kind === 'config') return 'Config file';
  if (current.value) return server.value?.manifest?.title || current.value.server;
  return 'MCP';
});

function manage(name: string) {
  const s = state.value.servers.find((x) => x.name === name);
  if (!s?.manifest) return;
  const first = s.manifest.views.find((v: Json) => v.available) || s.manifest.views[0];
  page.value = { kind: 'manage', server: name, view: first.id };
}
function back(): boolean {
  if (page.value.kind === 'list') return false;
  page.value = { kind: 'list' };
  void loadIntegrations();
  return true;
}

/* ---------- the global approval mode: saved as it changes, like the per-tool rows ---------- */

const approval = computed(() => config.tools?.toolApproval || config.cfg?.toolApproval || 'writes');
const approvalLocked = computed(() => !session.can(FEATURE.SETTINGS) || config.isLocked('toolApproval') || Boolean(config.cfg?.frozen));
const approvalWhy = computed(() => {
  if (!session.can(FEATURE.SETTINGS)) return 'changing it needs the settings permission';
  if (config.cfg?.frozen) return 'frozen deployment: change the config file';
  return config.isLocked('toolApproval') ? 'set in code' : 'Whether MCP tool calls wait for your approval. Each tool can override it.';
});
const approvalMsg = ref('');
async function setMode(e: Event) {
  const toolApproval = (e.target as HTMLSelectElement).value;
  approvalMsg.value = '';
  try {
    await api.post('/api/config', { toolApproval });
    await Promise.all([config.load(), config.loadTools()]);
  } catch (err) { approvalMsg.value = err.message; }
}

/* ---------- the raw config file ---------- */

const text = ref('');
const msg = ref('');
const saving = ref(false);
watch(() => config.mcp, (m) => { if (m) text.value = m.text; }, { immediate: true });
const fileLocked = computed(() => Boolean(config.mcp?.locked));
const where = computed(() => {
  const m = config.mcp;
  if (!m) return config.mcpError;
  return m.readOnly ? 'managed by your administrator' : m.locked ? 'set in code (read-only)' : m.path;
});

async function saveFile() {
  saving.value = true;
  try {
    const out = await api.post('/api/mcp', { text: text.value });
    await config.loadTools();
    msg.value = out.mcpErrors?.length ? out.mcpErrors.join('; ') : 'connected';
    await config.load();
    void loadIntegrations();
  } catch (err) {
    msg.value = err.message;
  } finally {
    saving.value = false;
  }
}

// Re-read on every open: what a server offers can change between visits, and
// the composer menu may have switched tools since.
const { isOpen } = usePanel(PANEL.MCP, {
  onOpen: () => {
    page.value = { kind: 'list' };
    msg.value = '';
    approvalMsg.value = '';
    return Promise.all([loadIntegrations(), ...(manages.value ? [config.loadMcp(), config.loadTools()] : [])]);
  },
  onClose: ({ swapping }) => { if (!swapping) useChat().focusTick++; },
  onEscape: back
});
</script>

<template>
  <section :id="PANEL.MCP" :class="{ open: isOpen }" aria-label="MCP">
    <div class="panel-head">
      <button v-if="page.kind !== 'list'" type="button" class="set-back" @click="back">‹ All</button>
      <h2>{{ title }}</h2>
      <template v-if="manages && page.kind === 'list'">
        <label class="mcp-mode" :title="approvalWhy">
          <span>Ask before running</span>
          <select :value="approval" :disabled="approvalLocked" aria-label="Ask before running" @change="setMode">
            <option v-for="[v, l] in TOOL_APPROVALS" :key="v" :value="v">{{ l }}</option>
          </select>
        </label>
        <button type="button" @click="page = { kind: 'config' }">Config file</button>
      </template>
    </div>

    <div class="mcp-content">
      <!-- ---------- the config file ---------- -->
      <div v-if="page.kind === 'config'" class="sec">
        <div class="sec-h">Config file <span id="mcpPath" class="usage">{{ where }}</span></div>
        <textarea id="mcpText" v-model="text" rows="16" spellcheck="false" :readonly="fileLocked" aria-label="MCP config" />
        <div class="row">
          <div class="usage">{{ msg }}</div>
          <div class="no-shrink"><button type="button" :disabled="fileLocked || saving" @click="saveFile">{{ saving ? 'reconnecting…' : 'save & reconnect' }}</button></div>
        </div>
      </div>

      <!-- ---------- one server's management views ---------- -->
      <template v-else-if="page.kind === 'manage'">
        <template v-if="server && view">
          <div class="int-tabs" role="tablist">
            <button v-for="v in server.manifest.views" :key="v.id" type="button" role="tab" :aria-selected="v.id === view.id"
                    :class="{ active: v.id === view.id, off: !v.available }" @click="page = { kind: 'manage', server: server.name, view: v.id }">{{ v.title }}</button>
          </div>
          <div v-if="!view.available" class="int-view"><p class="int-notice">{{ view.reason || 'Not available to you.' }}</p></div>
          <IntegrationView v-else :key="`${server.name}/${view.id}`" :view="view" :base="`/api/integrations/${enc(server.name)}/views/${enc(view.id)}`" />
        </template>
        <p v-else class="empty">This server no longer offers that page.</p>
      </template>

      <!-- ---------- every server ---------- -->
      <template v-else>
        <p v-if="approvalMsg" class="int-error">{{ approvalMsg }}</p>
        <p v-if="error" class="int-error">{{ error }}</p>
        <p v-if="manages && config.toolsError" class="int-error">{{ config.toolsError }}</p>

        <section v-if="builtins.length" class="mcp-tier" aria-labelledby="mcp-tier-builtin">
          <!-- A div, not <header>: that element is styled as the app's top bar. -->
          <div class="mcp-tier-head"><h3 id="mcp-tier-builtin">Built-in</h3></div>
          <section class="panel-card int-card">
            <div class="int-head">
              <span class="int-icon">{{ ICON.tool }}</span>
              <div class="int-name"><h4>Built-in tools</h4><span class="usage">part of TinyWebUI · never ask before running</span></div>
            </div>
            <details class="int-tools">
              <summary>Tools · {{ onCount(builtins) }}</summary>
              <div class="tool-list">
                <ToolRow v-for="t in builtins" :key="t.name" :tool="t" :read-only="config.readOnly" :default-approval="defaultApproval(t)"
                         @toggle="toggleTool(t.name, $event)" @approval="setApproval(t.name, $event)" />
              </div>
            </details>
          </section>
        </section>

        <p v-if="loading && !cards.length" class="empty">Loading…</p>
        <p v-else-if="!cards.length && !manages" class="empty">No MCP servers are connected.</p>

        <section v-for="tier in tiers" :key="tier.id" class="mcp-tier" :aria-labelledby="`mcp-tier-${tier.id}`">
          <div class="mcp-tier-head"><h3 :id="`mcp-tier-${tier.id}`">{{ tier.title }}</h3><p>{{ tier.note }}</p></div>
          <p v-if="!tier.cards.length" class="mcp-tier-empty">None yet: add one in the config file.</p>
          <section v-for="c in tier.cards" :key="c.name" class="panel-card int-card">
            <div class="int-head">
              <img v-if="logo(c)" class="int-icon int-logo" :src="logo(c) ?? undefined" alt="">
              <span v-else class="int-icon">{{ ICON[c.info?.manifest?.icon] || ICON.plug }}</span>
              <div class="int-name"><h4>{{ c.info?.manifest?.title || c.name }}</h4><span class="usage">{{ meta(c) }}</span></div>
              <span class="int-chips">
                <span class="chip" :class="status(c) === 'ok' ? 'chip-ok' : 'chip-bad'">{{ status(c) === 'ok' ? 'connected' : status(c) }}</span>
                <span v-if="state.multiUser && c.info" class="chip">{{ c.info.perUser ? 'per person' : 'shared by everyone' }}</span>
              </span>
            </div>
            <p v-if="c.info?.manifest?.description" class="int-desc">{{ c.info.manifest.description }}</p>
            <p v-if="c.info?.error && !c.tools" class="int-error">{{ c.info.error }}</p>
            <p v-if="c.info?.manageError" class="int-error">Management page unavailable: {{ c.info.manageError }}</p>
            <button v-if="c.info?.manifest?.views.length" type="button" class="primary" @click="manage(c.name)">Manage</button>
            <p v-else-if="!manages && status(c) === 'ok' && !c.info?.manageError" class="usage">Its tools work in chats; it offers no management page.</p>
            <details v-if="c.tools" class="int-tools">
              <summary>Tools · {{ c.tools.status === 'ok' ? onCount(c.tools.tools) : c.tools.status }}</summary>
              <ServerTools :server="c.tools" />
            </details>
          </section>
        </section>
      </template>
    </div>
  </section>
</template>
