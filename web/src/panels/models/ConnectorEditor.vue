<script setup lang="ts">
/** One connector: an OpenAI-compatible API, its URL and a key if it needs one. Its models are added under it. */
import { ref, useId } from 'vue';
import Icon from '../../ui/Icon.vue';
import { api } from '../../core/api.ts';
import type { ConnectorDraft, Draft } from '../settings/draft.ts';

const props = defineProps<{ draft: Draft, connector: ConnectorDraft, locked: boolean }>();
const emit = defineEmits<{ remove: [], addModel: [connectorId: string] }>();
const uid = useId();
const fid = (key: string) => `${uid}-${key}`;
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
          <label :for="fid('id')">Id</label>
          <!-- An id is what models name; renaming a saved one would orphan them. -->
          <input :id="fid('id')" ref="idEl" v-model="connector.id" placeholder="local" spellcheck="false" :readonly="Boolean(connector.savedId)" :disabled="locked" @change="renamed">
          <small>What a model names as its connection.</small>
        </div>
        <div>
          <label :for="fid('label')">Label</label>
          <input :id="fid('label')" v-model="connector.label" placeholder="Local models" spellcheck="false" :disabled="locked">
          <small>What it is called here.</small>
        </div>
        <div>
          <label :for="fid('url')">API URL</label>
          <input :id="fid('url')" v-model="connector.baseUrl" placeholder="http://localhost:11434/v1" spellcheck="false" :disabled="locked">
          <small>The base URL, usually ending in /v1.</small>
        </div>
        <div>
          <label :for="fid('key')">API key</label>
          <!-- new-password, not off: browsers ignore off on password fields and fill in the saved login. -->
          <input :id="fid('key')" v-model="connector.apiKey" type="password" autocomplete="new-password" spellcheck="false" :disabled="locked || connector.clearKey"
                 :placeholder="connector.hasApiKey ? `set (…${connector.keyHint}), blank keeps it` : 'optional'">
          <small>{{ connector.hasApiKey ? 'Write-only. Blank keeps the current key.' : 'Optional: leave blank for a server that needs none.' }}</small>
        </div>
        <div v-if="connector.hasApiKey">
          <label :for="fid('clear')">Remove the stored key</label>
          <span class="set-switch">
            <input :id="fid('clear')" v-model="connector.clearKey" type="checkbox" role="switch" :disabled="locked">
            <span class="switch-track" />
          </span>
          <small>On save, it is deleted from the secrets file.</small>
        </div>
        <div>
          <label :for="fid('test')">Check it</label>
          <span class="set-inline-btn set-test">
            <button :id="fid('test')" type="button" :disabled="locked" @click="test">Test connection</button>
            <span class="head-status" role="status">{{ msg }}</span>
          </span>
          <small>Asks the API for its models with what is typed here.</small>
        </div>
      </div>
    </section>
    <div class="set-foot">
      <button type="button" class="danger" :disabled="locked" @click="emit('remove')">Remove connection</button>
      <button type="button" class="primary with-icon" :disabled="locked" @click="addModel">Add a model<Icon name="arrowRight" /></button>
    </div>
  </div>
</template>
