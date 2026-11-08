<script setup lang="ts">
/** MCP servers: the raw config file, and every tool they offer. */
import { computed, ref, watch } from 'vue';
import { api } from '../core/api.ts';
import { useConfig } from '../stores/config.ts';
import { PANEL } from '../stores/panels.ts';
import { usePanel } from './usePanel.ts';
import ToolList from './ToolList.vue';

const config = useConfig();
const text = ref('');
const msg = ref('');
const saving = ref(false);
const list = ref<InstanceType<typeof ToolList>>();

// The raw editor and the tool list are reloaded on open, so they reflect any
// toggles made from the composer menu.
const { isOpen } = usePanel(PANEL.MCP, { onOpen: () => Promise.all([config.loadMcp(), config.loadTools()]) });

watch(() => config.mcp, (m) => { if (m) text.value = m.text; }, { immediate: true });
const locked = computed(() => Boolean(config.mcp?.locked));
const where = computed(() => {
  const m = config.mcp;
  if (!m) return config.mcpError;
  return m.readOnly ? 'managed by your administrator' : m.locked ? 'set in code (read-only)' : m.path;
});

async function save() {
  saving.value = true;
  try {
    const out = await api.post('/api/mcp', { text: text.value });
    await config.loadTools();
    msg.value = out.mcpErrors?.length ? out.mcpErrors.join('; ') : 'connected';
    await config.load();
  } catch (err) {
    msg.value = err.message;
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section id="mcp" :class="{ open: isOpen }" aria-label="MCP servers">
    <div class="automation-head"><h2>MCP servers</h2></div>
    <div class="settings-content">
      <div class="sec">
        <div class="sec-h">config file <span id="mcpPath" class="usage">{{ where }}</span></div>
        <textarea id="mcpText" v-model="text" rows="9" spellcheck="false" :readonly="locked" aria-label="MCP config" />
        <div class="row">
          <div class="usage">{{ msg }}</div>
          <div class="no-shrink"><button type="button" :disabled="locked || saving" @click="save">{{ saving ? 'reconnecting…' : 'save & reconnect' }}</button></div>
        </div>
        <div>
          <label>tools <span class="usage">{{ list?.counts }}</span></label>
          <ToolList ref="list" />
        </div>
      </div>
    </div>
  </section>
</template>
