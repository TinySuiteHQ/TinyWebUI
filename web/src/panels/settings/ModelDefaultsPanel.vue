<script setup lang="ts">
/** Model defaults: the prompt, sampling, tool turns and caching every model inherits unless it sets its own. */
import { computed } from 'vue';
import { useChat } from '../../stores/chat.ts';
import { useSession } from '../../stores/session.ts';
import { PANEL } from '../../stores/panels.ts';
import { usePanel } from '../usePanel.ts';
import { CACHE_MODES, CACHE_TTLS, REASONING_REPLAY } from './draft.ts';
import { useSettingsDraft } from './draft_store.ts';
import SettingsHead from './SettingsHead.vue';

const store = useSettingsDraft();
const draft = computed(() => store.draft);
const { locked, why } = store;
// Roles exist only with accounts; there, a role may set its own of these.
const session = useSession();

const { isOpen } = usePanel(PANEL.MODEL_DEFAULTS, {
  onOpen: store.open,
  onClose: ({ swapping }) => { if (!swapping) useChat().focusTick++; },
  canClose: store.canClose
});
</script>

<template>
  <section :id="PANEL.MODEL_DEFAULTS" class="set-panel" :class="{ open: isOpen }" aria-label="Model defaults">
    <SettingsHead title="Model defaults" />
    <div v-if="draft" class="settings-content">
      <section class="set-group">
        <header><h3>Prompt</h3><p>The system prompt sent at the start of every chat. A model can replace it with its own{{ session.personal ? ', and a role can replace both under People & roles' : '' }}.</p></header>
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
          <div v-if="store.admin"><label for="cache">Prompt caching</label>
            <select id="cache" v-model="draft.form.cache" :disabled="locked('cache')"><option value="true">On</option><option value="false">Off</option></select></div>
          <div><label for="cacheMode">Cache style</label>
            <select id="cacheMode" v-model="draft.form.cacheMode" :disabled="locked('cacheMode')"><option v-for="[v, l] in CACHE_MODES" :key="v" :value="v">{{ l }}</option></select>
            <small>Automatic is right for OpenRouter and local models; set it for other gateways.</small></div>
          <div><label for="cacheTtl">Prompt cache lifetime</label>
            <select id="cacheTtl" v-model="draft.form.cacheTtl" :disabled="locked('cacheTtl')"><option v-for="[v, l] in CACHE_TTLS" :key="v" :value="v">{{ l }}</option></select>
            <small>Anthropic models. 1 hour costs more to write, survives longer pauses.</small></div>
        </div>
      </section>
      <section v-if="store.admin" class="set-group">
        <header><h3>Advanced</h3><p>Rarely changed.</p></header>
        <div class="set-grid">
          <div><label for="reasoningReplay">Replay past reasoning</label>
            <select id="reasoningReplay" v-model="draft.form.reasoningReplay" :disabled="locked('reasoningReplay')"><option v-for="[v, l] in REASONING_REPLAY" :key="v" :value="v">{{ l }}</option></select></div>
          <div class="span-2"><label for="extraBody">Extra request body (JSON)</label>
            <textarea id="extraBody" v-model="draft.form.extraBody" class="mono" rows="4" spellcheck="false" placeholder="{}" :disabled="locked('extraBody')" />
            <small>Merged into every completion request, e.g. gateway routing.</small></div>
        </div>
      </section>
    </div>
  </section>
</template>
