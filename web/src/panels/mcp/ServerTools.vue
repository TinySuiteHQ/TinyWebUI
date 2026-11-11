<script setup lang="ts">
/**
 * One MCP server's tools, inside its card: the switch that connects or
 * disconnects it, why it failed and when it tries again, its instructions,
 * and each tool with its own switch and approval.
 */
import { useConfig } from '../../stores/config.ts';
import { useToolActions } from './tool_actions.ts';
import ToolRow from './ToolRow.vue';

// A server from /api/tools, read field by field.
type Json = any;
defineProps<{ server: Json }>();

const config = useConfig();
const { toggleTool, setApproval, retry, toggleServer, defaultApproval } = useToolActions();
const STATUS_LABEL: Record<string, string> = { ok: 'connected', disabled: 'disabled', error: 'failed to connect' };
const installHref = (url: string) => (/^https:\/\//.test(url) ? url : '#');
const checked = (e: Event) => (e.target as HTMLInputElement).checked;
</script>

<template>
  <div class="tool-group server" :class="server.status">
    <div class="tool-group-h">
      <label class="tgl"><input type="checkbox" :checked="server.status !== 'disabled'" :disabled="config.readOnly"
             :title="server.status === 'disabled' ? 'Disabled: click to reconnect' : 'Click to disconnect this server'"
             @change="toggleServer(server.name, !checked($event))"></label>
      <span class="dot" /><span class="name">{{ server.status === 'disabled' ? 'Disconnected' : 'Connected' }}</span>
      <span class="meta">{{ server.status === 'ok' ? `${server.tools.length} tool${server.tools.length === 1 ? '' : 's'}` : server.install ? `needs ${server.install.name}` : STATUS_LABEL[server.status] }}</span>
    </div>
    <div v-if="server.status === 'error' && server.error" class="tool-group-err">
      {{ server.error }}
      <a v-if="server.install" class="install-link" :href="installHref(server.install.url)" target="_blank" rel="noopener noreferrer">Install {{ server.install.name }}</a>
    </div>
    <div v-if="server.status === 'error'" class="tool-group-retry">
      <span v-if="server.retry">{{ server.retry.attempts }} failed attempt{{ server.retry.attempts === 1 ? '' : 's' }}{{ server.retry.nextAt ? ` · tries again at ${new Date(server.retry.nextAt).toLocaleTimeString()}` : '' }}</span>
      <button type="button" @click="retry(server.name)">Retry now</button>
    </div>
    <details v-if="server.status === 'ok' && server.instructions" class="tool-group-instructions">
      <summary>Instructions</summary>
      <div class="body">{{ server.instructions }}</div>
    </details>
    <template v-if="server.status === 'ok'">
      <div v-if="!server.tools.length" class="empty">No tools</div>
      <ToolRow v-for="t in server.tools" :key="t.name" :tool="t" :read-only="config.readOnly" :default-approval="defaultApproval(t)"
               @toggle="toggleTool(t.name, $event)" @approval="setApproval(t.name, $event)" />
    </template>
  </div>
</template>
