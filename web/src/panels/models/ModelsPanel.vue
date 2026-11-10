<script setup lang="ts">
/**
 * Models: the connections and the models each serves, with a page per thing
 * opened from them. All of it edits the shared settings draft, so moving to
 * Model defaults or Chat behaviour and back keeps the edits, and one Save
 * writes them all.
 */
import { computed, ref, watch } from 'vue';
import { api } from '../../core/api.ts';
import { useChat } from '../../stores/chat.ts';
import { PANEL } from '../../stores/panels.ts';
import { usePanel } from '../usePanel.ts';
import { connectorDraft, modelDraft, type ConnectorDraft, type ModelDraft } from '../settings/draft.ts';
import { useSettingsDraft } from '../settings/draft_store.ts';
import SettingsHead from '../settings/SettingsHead.vue';
import SaveBar from '../settings/SaveBar.vue';
import ModelsHome from './ModelsHome.vue';
import ConnectorEditor from './ConnectorEditor.vue';
import ModelEditor from './ModelEditor.vue';

type View = 'home' | 'endpoint' | 'connector' | 'model';

const store = useSettingsDraft();
const draft = computed(() => store.draft);
const { locked, why } = store;
// Someone who may only look sees the catalog with every control off.
const catalogLocked = computed(() => store.catalogLocked || store.readOnly);

const view = ref<View>('home');
const editing = ref<ConnectorDraft | ModelDraft | null>(null);
const testMsg = ref('');
const content = ref<HTMLElement>();

const title = computed(() => {
  const e = editing.value;
  if (view.value === 'endpoint') return 'Default connection';
  if (view.value === 'connector' && e) return e.label || e.id || 'New connection';
  if (view.value === 'model' && e) return e.label || e.id || 'New model';
  return 'Models';
});

function show(next: View, item: ConnectorDraft | ModelDraft | null = null) {
  view.value = next;
  editing.value = item;
  testMsg.value = '';
  if (content.value) content.value.scrollTop = 0;
}

/** Esc and Back: one page up, or false when already at the top. */
function back(): boolean {
  if (view.value === 'home') return false;
  show('home');
  return true;
}

function newConnector() {
  const c = connectorDraft();
  draft.value?.connectors.push(c);
  show('connector', c);
}

function newModel(connector: string) {
  const d = draft.value;
  if (!d) return;
  // Without a default connection a model needs one to be served from: the first there is.
  const cid = connector || (d.defaultEndpoint ? '' : d.connectors[0]?.id.trim() || '');
  const m = modelDraft(cid ? { connector: cid } : {});
  d.models.push(m);
  show('model', m);
}

function removeEditing() {
  const d = draft.value;
  const e = editing.value;
  if (!d || !e) return;
  d.connectors = d.connectors.filter((c) => c !== e);
  d.models = d.models.filter((m) => m !== e);
  show('home');
}

// Discard, a save or a reload replaces the draft wholesale; an editor still
// bound to the old one would take edits that go nowhere. Follow the item into
// the new draft by its id, or go back to the list when it is not there (an
// unsaved one that was discarded).
watch(() => store.draft, (d) => {
  const e = editing.value;
  if (!d || !e) return;
  const id = e.id.trim();
  const next = view.value === 'connector'
    ? d.connectors.find((c) => c.id.trim() === id)
    : d.models.find((m) => m.id.trim() === id);
  if (id && next) editing.value = next;
  else show('home');
});

async function testDefault() {
  testMsg.value = 'testing…';
  try {
    const out = await api.post('/api/connectors/test', { id: 'default', baseUrl: draft.value?.form.baseUrl.trim(), apiKey: draft.value?.form.apiKey });
    testMsg.value = out.ok ? `reachable${out.models != null ? ` · ${out.models} models` : ''}` : out.error || `status ${out.status}`;
  } catch (err) { testMsg.value = err.message; }
}

const { isOpen } = usePanel(PANEL.MODELS, {
  // Each visit starts on the list; edits in progress are kept by the draft, not by the view.
  onOpen: () => { show('home'); return store.open(); },
  onClose: ({ swapping }) => { if (!swapping) useChat().focusTick++; },
  onEscape: back,
  canClose: store.canClose
});
</script>

<template>
  <section :id="PANEL.MODELS" class="set-panel" :class="{ open: isOpen }" aria-label="Models">
    <SettingsHead :title="title" :back="view !== 'home'" @back="back" />
    <div v-if="draft" ref="content" class="settings-content">
      <ModelsHome v-if="view === 'home'" :draft="draft" :catalog-locked="catalogLocked" :model-locked="locked('model')"
                  @endpoint="show('endpoint')" @connector="show('connector', $event)" @model="show('model', $event)"
                  @add-model="newModel" @add-connector="newConnector" />

      <section v-else-if="view === 'endpoint'" class="set-group">
        <header><h3>Connection</h3><p>The OpenAI-compatible API used by every model that does not name a connection.</p></header>
        <div class="set-grid">
          <div class="span-2"><label for="baseUrl">API URL</label>
            <input id="baseUrl" v-model="draft.form.baseUrl" spellcheck="false" placeholder="http://localhost:11434/v1" :disabled="locked('baseUrl')" :title="why('baseUrl')"></div>
          <div class="span-2"><label for="apiKey">API key</label>
            <!-- new-password, not off: browsers ignore off on password fields and fill in the saved login. -->
            <input id="apiKey" v-model="draft.form.apiKey" type="password" autocomplete="new-password" spellcheck="false" :disabled="locked('apiKey')" :title="why('apiKey')"
                   :placeholder="draft.defaultKey.set ? `set (…${draft.defaultKey.hint}) — blank keeps it` : 'optional'">
            <small>{{ draft.defaultKey.set ? 'Write-only. Blank keeps the current key.' : 'Optional: leave blank for a server that needs none.' }}</small></div>
          <div class="cfg-actions span-2"><button type="button" :disabled="locked('baseUrl')" @click="testDefault">Test connection</button><span class="head-status">{{ testMsg }}</span></div>
        </div>
      </section>

      <ConnectorEditor v-else-if="view === 'connector' && editing" :key="editing.key" :draft="draft" :connector="editing as ConnectorDraft"
                       :locked="catalogLocked" @remove="removeEditing" @add-model="newModel" />
      <ModelEditor v-else-if="view === 'model' && editing" :key="editing.key" :draft="draft" :model="editing as ModelDraft"
                   :locked="catalogLocked" @remove="removeEditing" />
    </div>
    <SaveBar />
  </section>
</template>
