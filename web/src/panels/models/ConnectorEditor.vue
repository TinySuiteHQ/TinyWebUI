<script setup lang="ts">
/** One connector: an OpenAI-compatible API, its URL and a key if it needs one. Its models are added under it. */
import { ref } from 'vue';
import { api } from '../../core/api.ts';
import type { ConnectorDraft, Draft } from '../settings/draft.ts';

const props = defineProps<{ draft: Draft, connector: ConnectorDraft, locked: boolean }>();
const emit = defineEmits<{ remove: [], addModel: [connectorId: string] }>();
const msg = ref('');
const idEl = ref<HTMLInputElement>();
let lastId = props.connector.id;

// A connector still being named carries the models already added under it.
function renamed() {
  const next = props.connector.id.trim();
  if (lastId) for (const m of props.draft.models) if (m.connector === lastId) m.connector = next;
  lastId = next;
}

async function test() {
  msg.value = 'testing…';
  try {
    const out = await api.post('/api/connectors/test', { id: props.connector.id.trim(), baseUrl: props.connector.baseUrl.trim(), apiKey: props.connector.apiKey });
    msg.value = out.ok ? `reachable${out.models != null ? ` · ${out.models} models` : ''}` : out.error || `status ${out.status}`;
  } catch (err) { msg.value = err.message; }
}

// The second step of setting one up: the models people pick from it.
function addModel() {
  const id = props.connector.id.trim();
  if (!id) { msg.value = 'give the connection an id first'; idEl.value?.focus(); return; }
  emit('addModel', id);
}
</script>

<template>
  <div>
    <section class="set-group">
      <header><h3>Connection</h3><p>An OpenAI-compatible API: its URL, and a key if it needs one. Its models are added under it.</p></header>
      <div class="set-grid">
        <div>
          <label>Id</label>
          <!-- An id is what models name; renaming a saved one would orphan them. -->
          <input ref="idEl" v-model="connector.id" placeholder="local" spellcheck="false" :readonly="Boolean(connector.savedId)" :disabled="locked" @change="renamed">
          <small>What a model names as its connection.</small>
        </div>
        <div><label>Label</label><input v-model="connector.label" placeholder="Local models" spellcheck="false" :disabled="locked"></div>
        <div class="span-2"><label>API URL</label><input v-model="connector.baseUrl" placeholder="http://localhost:11434/v1" spellcheck="false" :disabled="locked"></div>
        <div class="span-2">
          <label>API key</label>
          <!-- new-password, not off: browsers ignore off on password fields and fill in the saved login. -->
          <input v-model="connector.apiKey" type="password" autocomplete="new-password" spellcheck="false" :disabled="locked"
                 :placeholder="connector.hasApiKey ? `set (…${connector.keyHint}) — blank keeps it` : 'optional'">
          <small>{{ connector.hasApiKey ? 'Write-only. Blank keeps the current key.' : 'Optional: leave blank for a server that needs none.' }}</small>
        </div>
        <div v-if="connector.hasApiKey" class="span-2">
          <label class="inline-check"><input v-model="connector.clearKey" type="checkbox" :disabled="locked"> remove stored key</label>
        </div>
        <div class="cfg-actions span-2"><button type="button" :disabled="locked" @click="test">Test connection</button><span class="head-status">{{ msg }}</span></div>
      </div>
    </section>
    <div class="set-foot">
      <button type="button" class="danger" :disabled="locked" @click="emit('remove')">Remove connection</button>
      <button type="button" class="primary" :disabled="locked" @click="addModel">Add a model →</button>
    </div>
  </div>
</template>
