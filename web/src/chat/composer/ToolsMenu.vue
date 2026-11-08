<script setup lang="ts">
/**
 * The + menu: attach files, and switch tools and MCP servers on and off.
 * Re-read from the server every time it opens, so it never shows a state the
 * server has already moved past.
 */
import { computed, onMounted, ref } from 'vue';
import { api } from '../../core/api.ts';
import { FEATURE } from '../../../../shared/features.ts';
import { useSession } from '../../stores/session.ts';
import { useConfig } from '../../stores/config.ts';
import { useChat } from '../../stores/chat.ts';
import Icon from '../../ui/Icon.vue';
import Switch from '../../ui/Switch.vue';

const emit = defineEmits<{ close: [], pickFiles: [], library: [], manage: [] }>();
const session = useSession();
const config = useConfig();
const chat = useChat();

// /api/tools: { internal: Tool[], servers: Server[] }, read field by field.
type Json = any;
const data = ref<Json | null>(null);
const error = ref('');

const canAttach = computed(() => session.can(FEATURE.ATTACHMENTS) || session.can(FEATURE.IMAGES));
const total = computed(() => (data.value ? [...data.value.internal, ...data.value.servers.flatMap((s: Json) => s.tools)] : []));

async function refresh(out: Json) {
  data.value = out;
  config.loadTools();
  config.load();
}
const toggleTool = async (name: string, on: boolean) => refresh(await api.post('/api/tools/toggle', { name, disabled: !on }));
async function toggleServer(name: string, on: boolean) {
  await refresh(await api.post(`/api/mcp/servers/${encodeURIComponent(name)}/toggle`, { disabled: !on }));
  config.loadMcp();
}
const metaOf = (s: Json) => (s.status === 'disabled' ? 'off'
  : s.status === 'error' ? (s.install ? `needs ${s.install.name}` : 'not connected')
  : `${s.tools.filter((t: Json) => !t.disabled).length}/${s.tools.length}`);
const installHref = (url: string) => (/^https:\/\//.test(url) ? url : '#');

onMounted(async () => {
  if (!session.can(FEATURE.TOOLS)) return;
  try { data.value = await api.get('/api/tools'); } catch (err) { error.value = `Could not load tools: ${err.message}`; }
});
</script>

<template>
  <template v-if="canAttach">
    <button type="button" class="pop-item" role="menuitem" @click="emit('pickFiles')"><Icon name="paperclip" /><span>Attach files</span></button>
    <!-- Documents only: an image has no stored text to reuse. -->
    <button v-if="session.can(FEATURE.ATTACHMENTS)" type="button" class="pop-item" role="menuitem" @click="emit('library')">
      <Icon name="history" /><span>Attach from earlier chats</span>
    </button>
    <hr v-if="session.can(FEATURE.TOOLS)" class="pop-sep">
  </template>
  <template v-if="session.can(FEATURE.TOOLS)">
    <!-- The switches still matter for other models, so they stay; this says why nothing is called. -->
    <div v-if="session.me.modelTools === false" class="pop-note pop-warn">The current model is set to use no tools. These switches apply to the other models.</div>
    <div class="pop-scroll">
      <div v-if="error" class="pop-note">{{ error }}</div>
      <div v-else-if="!data" class="pop-note">Loading tools…</div>
      <template v-else>
        <div class="pop-label">Tools · {{ total.filter((t) => !t.disabled).length }} of {{ total.length }} on</div>
        <details v-if="data.internal.length" class="pop-group">
          <summary class="pop-item">
            <span class="pop-dot ok" /><span class="pop-name">Built-in</span>
            <span class="pop-meta">{{ data.internal.filter((t: any) => !t.disabled).length }}/{{ data.internal.length }}</span>
          </summary>
          <div class="pop-tools">
            <div v-for="t in data.internal" :key="t.name" class="pop-tool">
              <span class="pop-tool-name" :title="t.description || ''">{{ t.name }}</span>
              <Switch :on="!t.disabled" :label="t.name" :read-only="config.readOnly" :toggle="(next) => toggleTool(t.name, next)" @error="chat.addError" />
            </div>
          </div>
        </details>
        <details v-for="s in data.servers" :key="s.name" class="pop-group">
          <summary class="pop-item" :title="s.error || undefined">
            <span class="pop-dot" :class="s.status || 'ok'" /><span class="pop-name">{{ s.name }}</span>
            <span class="pop-meta">{{ metaOf(s) }}</span>
            <Switch :on="s.status !== 'disabled'" :label="`${s.name} server`" :read-only="config.readOnly"
                    :toggle="(next) => toggleServer(s.name, next)" @error="chat.addError" />
          </summary>
          <div class="pop-tools">
            <div v-for="t in s.tools" :key="t.name" class="pop-tool">
              <span class="pop-tool-name" :title="t.description || ''">{{ t.name }}</span>
              <Switch :on="!t.disabled" :label="t.name" :read-only="config.readOnly" :toggle="(next) => toggleTool(t.name, next)" @error="chat.addError" />
            </div>
            <div v-if="s.status === 'error' && s.error" class="pop-note">
              {{ s.error }}
              <a v-if="s.install" class="install-link" :href="installHref(s.install.url)" target="_blank" rel="noopener noreferrer">Install {{ s.install.name }}</a>
            </div>
            <div v-else-if="!s.tools.length" class="pop-note">No tools</div>
          </div>
        </details>
        <div v-if="!data.servers.length" class="pop-note">No MCP servers yet. Add them under MCP servers.</div>
      </template>
    </div>
    <button v-if="session.can(FEATURE.MCP)" type="button" class="pop-item pop-foot" @click="emit('manage')">Manage MCP servers</button>
  </template>
</template>
