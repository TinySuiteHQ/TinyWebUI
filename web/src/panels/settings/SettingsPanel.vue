<script setup lang="ts">
/**
 * Settings: a home page (endpoints and their models) and a page per thing
 * opened from it, all editing one unsaved draft, written by one Save. Someone
 * without the settings feature sees only what an admin lets them personalise.
 */
import { computed, ref, watch } from 'vue';
import { api } from '../../core/api.ts';
import { useSession } from '../../stores/session.ts';
import { useConfig } from '../../stores/config.ts';
import { useChat } from '../../stores/chat.ts';
import { useTheme } from '../../stores/theme.ts';
import { PANEL } from '../../stores/panels.ts';
import { usePanel } from '../usePanel.ts';
import {
  CACHE_MODES, CACHE_TTLS, REASONING_REPLAY, TOOL_APPROVALS, buildPatch, connectorDraft, fromConfig, modelDraft,
  type ConnectorDraft, type Draft, type ModelDraft
} from './draft.ts';
import SettingsHome from './SettingsHome.vue';
import AppearanceSection from './AppearanceSection.vue';
import ConnectorEditor from './ConnectorEditor.vue';
import ModelEditor from './ModelEditor.vue';

type View = 'home' | 'endpoint' | 'connector' | 'model' | 'defaults' | 'conversation' | 'prefs';
const TITLES: Record<View, string> = {
  home: 'General', endpoint: 'Default endpoint', connector: 'Connector', model: 'Model',
  defaults: 'Defaults for all models', conversation: 'Conversation', prefs: 'My preferences'
};

const session = useSession();
const config = useConfig();
const theme = useTheme();

const draft = ref<Draft | null>(null);
const view = ref<View>('home');
const editing = ref<ConnectorDraft | ModelDraft | null>(null);
const saveMsg = ref('');
const testMsg = ref('');
const content = ref<HTMLElement>();
// The draft as of the last load, to tell whether closing would lose edits.
let saved = '';

const cfg = computed(() => config.cfg);
const readOnly = computed(() => config.readOnly);
const admin = computed(() => config.admin);
const frozen = computed(() => Boolean(cfg.value?.frozen));
const mine = computed(() => session.me.customize || []);
const ownPassword = computed(() => Boolean(session.me.hasPassword));
const catalogLocked = computed(() => frozen.value || config.lockedKeys.has('models') || config.lockedKeys.has('connectors'));
const locked = (key: string) => readOnly.value || config.lockedKeys.has(key);
const why = (key: string) => (frozen.value ? 'frozen deployment: change the config file' : readOnly.value ? 'managed by your administrator' : config.lockedKeys.has(key) ? 'set in code' : undefined);
const saveDisabled = computed(() => (readOnly.value ? !mine.value.includes('instructions') : frozen.value));
const baseMsg = computed(() => {
  if (config.loadError) return config.loadError;
  if (readOnly.value) return mine.value.length || ownPassword.value ? '' : 'managed by your administrator';
  return frozen.value ? 'frozen deployment: settings are managed in its files' : '';
});

const title = computed(() => {
  const e = editing.value;
  if (view.value === 'connector' && e) return e.label || e.id || 'New connector';
  if (view.value === 'model' && e) return e.label || e.id || 'New model';
  return TITLES[view.value];
});

// The browser's IANA zones, plus whatever the config holds if the browser
// does not list it, so a saved value is never silently swapped for another.
const zones = computed(() => {
  const all = Intl.supportedValuesOf?.('timeZone') ?? [];
  const current = draft.value?.form.timezone;
  return current && !all.includes(current) ? [...all, current] : all;
});

function snapshot(): string {
  const d = draft.value;
  if (!d) return '';
  if (readOnly.value) return d.myInstructions;
  try { return JSON.stringify([buildPatch(d, { admin: admin.value, lockedKeys: config.lockedKeys }), d.myInstructions]); } catch { return 'invalid'; }
}

function reset() {
  if (!cfg.value) return;
  draft.value = fromConfig(cfg.value, session.me);
  saved = snapshot();
}

function show(next: View, item: ConnectorDraft | ModelDraft | null = null) {
  view.value = next;
  editing.value = item;
  if (content.value) content.value.scrollTop = 0;
}

/** Esc and Back: one page up, or false when already at the top. */
function back(): boolean {
  if (view.value === 'home' || readOnly.value) return false;
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

async function testDefault() {
  testMsg.value = 'testing…';
  try {
    const out = await api.post('/api/connectors/test', { id: 'default', baseUrl: draft.value?.form.baseUrl.trim(), apiKey: draft.value?.form.apiKey });
    testMsg.value = out.ok ? `reachable${out.models != null ? ` · ${out.models} models` : ''}` : out.error || `status ${out.status}`;
  } catch (err) { testMsg.value = err.message; }
}

async function save() {
  const d = draft.value;
  if (!d) return;
  // Personal instructions go to the person's own prefs, whatever else they may edit.
  if (mine.value.includes('instructions')) {
    try { await api.post('/api/me/prefs', { instructions: d.myInstructions.trim() || null }); } catch (err) { saveMsg.value = `save failed (${err.message})`; return; }
    await session.loadAccess();
    if (readOnly.value) { saveMsg.value = 'saved'; saved = snapshot(); close({ force: true }); return; }
  }
  let patch;
  try { patch = buildPatch(d, { admin: admin.value, lockedKeys: config.lockedKeys }); } catch (err) { saveMsg.value = `save failed (${err.message})`; return; }
  try { await api.post('/api/config', patch); } catch (err) { saveMsg.value = `save failed (${err.message})`; return; }
  await config.load();
  await session.loadAccess(); // a changed model changes what it can take
  await config.loadTools(); // the per-tool "default" labels follow the global mode
  reset();
  saveMsg.value = 'saved';
  close({ force: true });
}

/** Whether closing now would drop unsaved edits; asks, and on yes goes back to what is saved. */
function canClose() {
  if (snapshot() === saved) return true;
  if (!window.confirm('Discard unsaved settings changes?')) return false;
  reset();
  return true;
}

/* ---------- password: its own form, apart from the draft ---------- */

const pw = ref({ current: '', next: '', confirm: '' });
const pwMsg = ref('');
const pwOk = ref(false);
const pwBusy = ref(false);
async function changePassword() {
  pwMsg.value = '';
  pwOk.value = false;
  if (pw.value.next !== pw.value.confirm) { pwMsg.value = 'The two new passwords do not match.'; return; }
  pwBusy.value = true;
  try {
    await api.post('/api/me/password', { current: pw.value.current, password: pw.value.next });
    pw.value = { current: '', next: '', confirm: '' };
    pwMsg.value = 'Password changed. Your other sessions were signed out.';
    pwOk.value = true;
  } catch (err) { pwMsg.value = err.message; } finally { pwBusy.value = false; }
}

const { isOpen, close } = usePanel(PANEL.SETTINGS, {
  onOpen: async () => {
    // A stale "saved" would read as this visit's.
    saveMsg.value = '';
    show(readOnly.value ? 'prefs' : 'home');
    // Themes too: an admin may have added or removed one since.
    await Promise.all([config.load(), theme.load()]);
    reset();
    show(readOnly.value ? 'prefs' : 'home');
  },
  // A panel swap leaves focus to the panel being opened; focusing the composer
  // would otherwise raise the mobile keyboard behind it.
  onClose: ({ swapping }) => { if (!swapping) useChat().focusTick++; },
  onEscape: back,
  canClose
});

// A reload of the config while nothing is being edited (startup, a toggle in
// the composer) refreshes the draft; it never overwrites edits in progress.
watch(cfg, () => { if (!draft.value || snapshot() === saved) reset(); }, { immediate: true });
</script>

<template>
  <section id="settings" :class="{ open: isOpen }" aria-label="Settings">
    <div class="automation-head">
      <button v-if="view !== 'home' && !readOnly" type="button" class="set-back" aria-label="Back to settings" @click="back">‹ Back</button>
      <h2>{{ title }}</h2>
      <span class="usage">{{ saveMsg || baseMsg }}</span>
      <!-- No Close of its own: the dialog's close asks this panel first (canClose), so unsaved edits still hold it. -->
      <button class="primary" type="button" :disabled="saveDisabled || !draft" @click="save">Save changes</button>
    </div>
    <div v-if="draft" ref="content" class="settings-content">
      <!-- ---------- home ---------- -->
      <template v-if="view === 'home'">
        <template v-if="admin">
          <div class="set-divider set-first"><h2>Connections &amp; models</h2><p>Each endpoint and the models it serves. Open a model to set its prompt, sampling and caching.</p></div>
          <SettingsHome :draft="draft" :catalog-locked="catalogLocked" :model-locked="locked('model')" @endpoint="show('endpoint')"
                        @connector="show('connector', $event)" @model="show('model', $event)" @add-model="newModel" @add-connector="newConnector" />
        </template>
        <nav class="set-nav" aria-label="More settings">
          <button type="button" class="set-link" @click="show('defaults')"><span><b>Defaults for all models</b><small>Prompt, sampling, tool turns and caching every model inherits.</small></span></button>
          <button type="button" class="set-link" @click="show('conversation')"><span><b>Conversation</b><small>Timezone, questions, tool approval and how long chats are trimmed.</small></span></button>
          <button type="button" class="set-link mine" @click="show('prefs')"><span><b>My preferences</b><small>Only for you: your instructions and theme.</small></span></button>
        </nav>
      </template>

      <!-- ---------- the default endpoint ---------- -->
      <section v-else-if="view === 'endpoint'" class="set-group">
        <header><h3>Default endpoint</h3><p>The OpenAI-compatible API used by every model that does not name a connector.</p></header>
        <div class="set-grid">
          <div class="span-2"><label for="baseUrl">API URL</label>
            <input id="baseUrl" v-model="draft.form.baseUrl" spellcheck="false" placeholder="http://localhost:11434/v1" :disabled="locked('baseUrl')" :title="why('baseUrl')"></div>
          <div class="span-2"><label for="apiKey">API key</label>
            <input id="apiKey" v-model="draft.form.apiKey" type="password" autocomplete="new-password" spellcheck="false" :disabled="locked('apiKey')"
                   :placeholder="draft.defaultKey.set ? `set (…${draft.defaultKey.hint}) — blank keeps it` : 'not set'">
            <small>Optional. Write-only: kept in the secrets file, never shown again. Leave blank to keep the current key.</small></div>
          <div class="span-2"><button type="button" @click="testDefault">Test connection</button> <span class="usage">{{ testMsg }}</span></div>
        </div>
      </section>

      <ConnectorEditor v-else-if="view === 'connector' && editing" :draft="draft" :connector="editing as ConnectorDraft" :locked="catalogLocked"
                       @remove="removeEditing" @add-model="newModel" />
      <ModelEditor v-else-if="view === 'model' && editing" :draft="draft" :model="editing as ModelDraft" :locked="catalogLocked" @remove="removeEditing" />

      <!-- ---------- defaults for all models ---------- -->
      <template v-else-if="view === 'defaults'">
        <!-- An admin picks the default per model (or on the endpoint card while there is no catalog). -->
        <section v-if="!admin" class="set-group">
          <header><h3>Default model</h3><p>The model new chats start with. Also switchable from the model pill in the message box.</p></header>
          <label for="model">Model id</label><input id="model" v-model="draft.form.model" spellcheck="false" :disabled="locked('model')" :title="why('model')">
        </section>
        <section class="set-group">
          <header><h3>Prompt</h3><p>The system prompt sent at the start of every chat.</p></header>
          <textarea id="systemPrompt" v-model="draft.form.systemPrompt" rows="10" aria-label="System prompt" :disabled="locked('systemPrompt')" :title="why('systemPrompt')" />
        </section>
        <section class="set-group">
          <header><h3>Sampling</h3></header>
          <div class="set-grid">
            <div><label for="temperature">Temperature</label><input id="temperature" v-model="draft.form.temperature" type="number" step="0.1" min="0" max="2" placeholder="Provider default" :disabled="locked('temperature')"></div>
            <div><label for="maxTokens">Max output tokens</label><input id="maxTokens" v-model="draft.form.maxTokens" type="number" min="1" placeholder="No limit" :disabled="locked('maxTokens')"></div>
          </div>
        </section>
        <section class="set-group">
          <header><h3>Tools</h3></header>
          <div class="set-grid">
            <div><label for="maxToolRounds">Max tool turns</label><input id="maxToolRounds" v-model="draft.form.maxToolRounds" type="number" min="1" max="50" :disabled="locked('maxToolRounds')"><small>Tool calls allowed per reply.</small></div>
          </div>
        </section>
        <section class="set-group">
          <header><h3>Caching</h3><p>Keeps the repeated start of a chat cheap to resend.</p></header>
          <div class="set-grid">
            <div v-if="admin"><label for="cache">Prompt caching</label>
              <select id="cache" v-model="draft.form.cache" :disabled="locked('cache')"><option value="true">On</option><option value="false">Off</option></select></div>
            <div><label for="cacheMode">Cache style</label>
              <select id="cacheMode" v-model="draft.form.cacheMode" :disabled="locked('cacheMode')"><option v-for="[v, l] in CACHE_MODES" :key="v" :value="v">{{ l }}</option></select>
              <small>Automatic is right for OpenRouter and local models; set it for other gateways.</small></div>
            <div><label for="cacheTtl">Prompt cache lifetime</label>
              <select id="cacheTtl" v-model="draft.form.cacheTtl" :disabled="locked('cacheTtl')"><option v-for="[v, l] in CACHE_TTLS" :key="v" :value="v">{{ l }}</option></select>
              <small>Anthropic models. 1 hour costs more to write, survives longer pauses.</small></div>
          </div>
        </section>
        <section v-if="admin" class="set-group">
          <header><h3>Advanced</h3><p>Rarely changed.</p></header>
          <div class="set-grid">
            <div><label for="reasoningReplay">Replay past reasoning</label>
              <select id="reasoningReplay" v-model="draft.form.reasoningReplay" :disabled="locked('reasoningReplay')"><option v-for="[v, l] in REASONING_REPLAY" :key="v" :value="v">{{ l }}</option></select></div>
            <div class="span-2"><label for="extraBody">Extra request body (JSON)</label>
              <textarea id="extraBody" v-model="draft.form.extraBody" class="mono" rows="4" spellcheck="false" placeholder="{}" :disabled="locked('extraBody')" />
              <small>Merged into every completion request, e.g. gateway routing.</small></div>
          </div>
        </section>
      </template>

      <!-- ---------- conversation ---------- -->
      <template v-else-if="view === 'conversation'">
        <section class="set-group">
          <header><h3>Date</h3></header>
          <div class="set-grid">
            <div class="span-2"><label for="timezone">Timezone</label>
              <select id="timezone" v-model="draft.form.timezone" :disabled="locked('timezone')"><option value="">Server's timezone</option><option v-for="z in zones" :key="z" :value="z">{{ z }}</option></select>
              <small>The zone the model is told today's date in.</small></div>
          </div>
        </section>
        <section class="set-group">
          <header><h3>Questions &amp; approval</h3><p>When the model waits for you.</p></header>
          <div class="set-grid">
            <div><label for="askUserTimeoutSeconds">Question timeout (s)</label>
              <input id="askUserTimeoutSeconds" v-model="draft.form.askUserTimeoutSeconds" type="number" min="0" max="86400" :disabled="locked('askUserTimeoutSeconds')">
              <small>How long a question from the model waits before it continues on its own. 0: wait until answered.</small></div>
            <div><label for="toolApproval">Ask before running</label>
              <select id="toolApproval" v-model="draft.form.toolApproval" :disabled="locked('toolApproval')">
                <option v-for="[v, l] in TOOL_APPROVALS" :key="v" :value="v">{{ l }}</option>
              </select>
              <small>Built-in tools never ask. Scheduled runs refuse calls that would.</small></div>
          </div>
        </section>
        <section class="set-group">
          <header><h3>Context &amp; compaction</h3><p>Keeps long chats fast and cheap by trimming old tool output.</p></header>
          <div class="set-grid">
            <div><label for="compactThreshold">Compact history above</label><input id="compactThreshold" v-model="draft.form.compactThreshold" type="number" min="0" step="1000" :disabled="locked('compactThreshold')"><small>Tokens. Old tool results are stubbed past this. 0 turns it off.</small></div>
            <div><label for="keepTurns">Always keep last</label><input id="keepTurns" v-model="draft.form.keepTurns" type="number" min="1" max="20" :disabled="locked('keepTurns')"><small>Recent turns whose tool results stay in full.</small></div>
            <div><label for="maxInlineChars">Stub single results above</label><input id="maxInlineChars" v-model="draft.form.maxInlineChars" type="number" min="0" step="1000" :disabled="locked('maxInlineChars')"><small>Characters. The turn that fetched it still reads it whole.</small></div>
            <div><label for="maxTurnChars">Stub even this turn above</label><input id="maxTurnChars" v-model="draft.form.maxTurnChars" type="number" min="0" step="10000" :disabled="locked('maxTurnChars')"><small>Characters. A result this big is stubbed right away, even for the turn that fetched it.</small></div>
            <div><label for="compactMinSaved">Only compact if it saves</label><input id="compactMinSaved" v-model="draft.form.compactMinSaved" type="number" min="0" step="1000" :disabled="locked('compactMinSaved')"><small>Characters. Compacting costs one cache miss, so small savings are skipped.</small></div>
            <div><label for="maxHistoryTokens">Hard history limit</label><input id="maxHistoryTokens" v-model="draft.form.maxHistoryTokens" type="number" min="0" step="10000" :disabled="locked('maxHistoryTokens')"><small>Tokens. Past this, the oldest turns stop being sent (they stay visible). 0 turns it off.</small></div>
            <template v-if="admin">
              <div><label for="llmCompaction">Summarise dropped turns</label>
                <select id="llmCompaction" v-model="draft.form.llmCompaction" :disabled="locked('llmCompaction')"><option value="true">Yes, with the chat's model</option><option value="false">No, just drop them</option></select></div>
              <div><label for="compactionMaxTokens">Summary length cap</label><input id="compactionMaxTokens" v-model="draft.form.compactionMaxTokens" type="number" min="256" step="256" :disabled="locked('compactionMaxTokens')"><small>Output tokens for that summary request.</small></div>
              <div><label for="expandCharBudget">Expand budget</label><input id="expandCharBudget" v-model="draft.form.expandCharBudget" type="number" min="0" step="1000" :disabled="locked('expandCharBudget')"><small>Characters one expand_context call may return.</small></div>
            </template>
          </div>
        </section>
      </template>

      <!-- ---------- my preferences ---------- -->
      <template v-else-if="view === 'prefs'">
        <section v-if="mine.includes('instructions')" class="set-group mine">
          <header><h3>My instructions</h3><p>Added after the system prompt on your chats only.</p></header>
          <textarea v-model="draft.myInstructions" rows="5" maxlength="4000" aria-label="My instructions" />
        </section>
        <!-- Local accounts only; behind a gateway (SSO) there is no password here to change. -->
        <form v-if="ownPassword" class="set-group mine" @submit.prevent="changePassword">
          <header><h3>Password</h3><p>At least {{ session.me.passwordMin }} characters. Changing it signs out your other sessions.</p></header>
          <!-- Tells password managers whose password this is; without it they guess, and fill the chat search. -->
          <input type="text" autocomplete="username" :value="session.me.user?.email || ''" hidden>
          <div class="set-grid">
            <div class="span-2"><label for="pwCurrent">Current password</label><input id="pwCurrent" v-model="pw.current" type="password" autocomplete="current-password" required></div>
            <div><label for="pwNew">New password</label><input id="pwNew" v-model="pw.next" type="password" autocomplete="new-password" :minlength="session.me.passwordMin || 0" required></div>
            <div><label for="pwConfirm">Confirm new password</label><input id="pwConfirm" v-model="pw.confirm" type="password" autocomplete="new-password" required></div>
          </div>
          <div class="pw-actions"><button class="primary" type="submit" :disabled="pwBusy">Change password</button>
            <span class="pw-msg" :class="{ ok: pwOk }" role="status">{{ pwMsg }}</span></div>
        </form>
        <AppearanceSection />
        <p v-if="readOnly && !mine.length && !ownPassword" class="empty">Settings are managed by your administrator.</p>
      </template>
    </div>
  </section>
</template>
