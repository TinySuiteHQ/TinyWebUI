<script setup lang="ts">
/**
 * The Models page for an admin: one card per connection with the models it
 * serves, and the top-level endpoint first only while it serves anything.
 * With none of them it is the first step of setting up: connect an endpoint,
 * then add its models. Drawn from the draft, so it shows unsaved edits.
 */
import { computed } from 'vue';
import type { ConnectorDraft, Draft, ModelDraft } from '../settings/draft.ts';
import ModelLink from './ModelLink.vue';

const props = defineProps<{ draft: Draft, catalogLocked: boolean, modelLocked: boolean }>();
const emit = defineEmits<{ endpoint: [], connector: [c: ConnectorDraft], model: [m: ModelDraft], addModel: [connectorId: string], addConnector: [] }>();

const host = (url: string) => { try { return new URL(url).host || url; } catch { return url; } };
const under = (cid: string) => props.draft.models.filter((m) => (m.connector || '') === cid);
const ids = computed(() => new Set(props.draft.connectors.map((c) => c.id.trim())));
// Models naming a connector that no longer exists still need a way in.
const orphans = computed(() => props.draft.models.filter((m) => m.connector && !ids.value.has(m.connector)));
const empty = computed(() => !props.draft.defaultEndpoint && !props.draft.connectors.length && !orphans.value.length);
const isDefault = (m: ModelDraft) => Boolean(m.id) && m.id === props.draft.form.model;
const baseUrl = computed(() => (props.draft.form.baseUrl || '').trim());
</script>

<template>
  <div>
    <section v-if="draft.defaultEndpoint" class="set-group ep-card">
      <div class="ep-head">
        <div><h3>Default connection</h3><p>{{ baseUrl ? host(baseUrl) : 'no URL set' }} · {{ draft.defaultKey.set ? `key …${draft.defaultKey.hint}` : 'no key' }}</p></div>
        <button type="button" @click="emit('endpoint')">Edit</button>
      </div>
      <div v-if="under('').length" class="model-list">
        <ModelLink v-for="m in under('')" :key="m.key" :model="m" :is-default="isDefault(m)" @open="emit('model', m)" />
      </div>
      <!-- No models listed, so any model id goes: the default model is typed here. -->
      <div v-if="!draft.models.length" class="ep-open">
        <label for="model">Model id</label>
        <input id="model" v-model="draft.form.model" spellcheck="false" :disabled="modelLocked">
        <small>No models are listed, so any model id goes. Add one to choose exactly which models people can pick.</small>
      </div>
      <p v-else-if="!under('').length" class="ep-empty">No models yet: add the ones people can pick.</p>
      <button v-if="!catalogLocked" type="button" class="add-model" @click="emit('addModel', '')">+ Add model</button>
    </section>

    <section v-for="c in draft.connectors" :key="c.key" class="set-group ep-card">
      <div class="ep-head">
        <div><h3>{{ c.label || c.id || 'New connection' }}</h3>
          <p>{{ c.id ? `${c.id} · ` : '' }}{{ c.baseUrl ? host(c.baseUrl) : 'no URL set' }} · {{ c.apiKey || (c.hasApiKey && !c.clearKey) ? 'key set' : 'no key' }}</p></div>
        <button type="button" @click="emit('connector', c)">Edit</button>
      </div>
      <div v-if="under(c.id.trim()).length" class="model-list">
        <ModelLink v-for="m in under(c.id.trim())" :key="m.key" :model="m" :is-default="isDefault(m)" @open="emit('model', m)" />
      </div>
      <p v-else class="ep-empty">No models yet: add the ones people can pick.</p>
      <button v-if="!catalogLocked" type="button" class="add-model" @click="emit('addModel', c.id.trim())">+ Add model</button>
    </section>

    <section v-if="orphans.length" class="set-group ep-card">
      <div class="ep-head"><div><h3>Unknown connection</h3><p>These models name a connection that is not defined.</p></div></div>
      <div class="model-list">
        <button v-for="m in orphans" :key="m.key" type="button" class="model-link" @click="emit('model', m)">
          <span class="model-text"><span class="model-name">{{ m.label || m.id || 'Untitled model' }}</span><span class="model-sub">{{ m.connector }}</span></span>
          <span class="chev" aria-hidden="true">›</span>
        </button>
      </div>
    </section>

    <section v-if="empty" class="set-group ep-card ep-setup">
      <h3>Connect a model API</h3>
      <p>Any OpenAI-compatible API: its URL, and an API key if it needs one. Then add the models people can pick from it.</p>
      <button v-if="!catalogLocked" type="button" class="primary" @click="emit('addConnector')">Add a connection</button>
    </section>
    <!-- The setup card has its own button; a second one under it would only repeat it. -->
    <div v-else-if="!catalogLocked" class="set-add"><button type="button" @click="emit('addConnector')">+ Add connection</button></div>
  </div>
</template>
