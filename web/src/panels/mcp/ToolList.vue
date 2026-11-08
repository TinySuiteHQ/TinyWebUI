<script setup lang="ts">
/**
 * Every tool the model can be offered: built-ins first, then each MCP server
 * with its health and its tools. Unchecking a tool stops offering it;
 * unchecking a server disconnects it outright. Redrawn from a fresh
 * /api/tools payload after every change, so it never drifts from what the
 * server actually did.
 */
import { computed } from 'vue';
import { api } from '../core/api.ts';
import { useConfig } from '../stores/config.ts';
import { useChat } from '../stores/chat.ts';
import ToolRow from './ToolRow.vue';

const config = useConfig();
const chat = useChat();
// /api/tools is read field by field.
type Json = any;

const data = computed<Json | null>(() => config.tools);
const mode = computed(() => data.value?.toolApproval || 'writes');
const counts = computed(() => {
  const d = data.value;
  if (!d) return '';
  const all = [...d.internal, ...d.servers.flatMap((s: Json) => s.tools)];
  const up = d.servers.filter((s: Json) => s.status === 'ok').length;
  return all.length ? `${all.filter((t: Json) => !t.disabled).length}/${all.length} enabled · ${up}/${d.servers.length} server${d.servers.length === 1 ? '' : 's'} up` : 'none';
});
defineExpose({ counts });

async function run(call: () => Promise<Json>) {
  try { config.tools = await call(); } catch (err) { chat.addError(err.message); config.loadTools(); }
}
const toggleTool = (name: string, disabled: boolean) => run(() => api.post('/api/tools/toggle', { name, disabled }));
const setApproval = (name: string, policy: string) => run(() => api.post('/api/tools/approval', { name, policy }));
const retry = (name: string) => run(() => api.post(`/api/mcp/servers/${encodeURIComponent(name)}/retry`, {}));
async function toggleServer(name: string, disabled: boolean) {
  await run(() => api.post(`/api/mcp/servers/${encodeURIComponent(name)}/toggle`, { disabled }));
  config.loadMcp(); // the raw editor's disabled: true/false has to catch up too
}

// What "default" resolves to for a tool under the global mode, so the select
// says what will actually happen.
function defaultApproval(t: Json) {
  if (mode.value === 'off') return 'never';
  if (mode.value === 'all') return 'ask';
  return t.readOnly === true ? 'never (read-only)' : 'ask (may write)';
}
const STATUS_LABEL: Record<string, string> = { ok: 'connected', disabled: 'disabled', error: 'failed to connect' };
const installHref = (url: string) => (/^https:\/\//.test(url) ? url : '#');
const checked = (e: Event) => (e.target as HTMLInputElement).checked;
</script>

<template>
  <div id="tools" class="tool-list">
    <div v-if="config.toolsError" class="empty">{{ config.toolsError }}</div>
    <template v-else-if="data">
      <div v-if="!data.internal.length && !data.servers.length" class="empty">no tools</div>
      <div v-if="data.internal.length" class="tool-group">
        <div class="tool-group-h">built-in</div>
        <ToolRow v-for="t in data.internal" :key="t.name" :tool="t" :read-only="config.readOnly" :default-approval="defaultApproval(t)"
                 @toggle="toggleTool(t.name, $event)" @approval="setApproval(t.name, $event)" />
      </div>
      <div v-for="s in data.servers" :key="s.name" class="tool-group server" :class="s.status">
        <div class="tool-group-h">
          <label class="tgl"><input type="checkbox" :checked="s.status !== 'disabled'" :disabled="config.readOnly"
                 :title="s.status === 'disabled' ? 'Disabled: click to reconnect' : 'Click to disconnect this server'"
                 @change="toggleServer(s.name, !checked($event))"></label>
          <span class="dot" /><span class="name">{{ s.name }}</span>
          <span class="meta">{{ s.status === 'ok' ? `${s.tools.length} tool${s.tools.length === 1 ? '' : 's'}` : s.install ? `needs ${s.install.name}` : STATUS_LABEL[s.status] }}</span>
        </div>
        <div v-if="s.status === 'error' && s.error" class="tool-group-err">
          {{ s.error }}
          <a v-if="s.install" class="install-link" :href="installHref(s.install.url)" target="_blank" rel="noopener noreferrer">Install {{ s.install.name }}</a>
        </div>
        <div v-if="s.status === 'error'" class="tool-group-retry">
          <span v-if="s.retry">{{ s.retry.attempts }} failed attempt{{ s.retry.attempts === 1 ? '' : 's' }}{{ s.retry.nextAt ? ` · tries again at ${new Date(s.retry.nextAt).toLocaleTimeString()}` : '' }}</span>
          <button type="button" @click="retry(s.name)">Retry now</button>
        </div>
        <details v-if="s.status === 'ok' && s.instructions" class="tool-group-instructions">
          <summary>instructions</summary>
          <div class="body">{{ s.instructions }}</div>
        </details>
        <template v-if="s.status === 'ok'">
          <div v-if="!s.tools.length" class="empty">no tools</div>
          <ToolRow v-for="t in s.tools" :key="t.name" :tool="t" :read-only="config.readOnly" :default-approval="defaultApproval(t)"
                   @toggle="toggleTool(t.name, $event)" @approval="setApproval(t.name, $event)" />
        </template>
      </div>
    </template>
  </div>
</template>
