<script setup lang="ts">
/**
 * Chat behaviour: the date the model is told, how long its questions wait, and
 * how long chats are trimmed. Ordered by how often each is changed: the
 * history limits first, the per-result character limits after.
 */
import { computed } from 'vue';
import { useChat } from '../../stores/chat.ts';
import { useSession } from '../../stores/session.ts';
import { PANEL } from '../../stores/panels.ts';
import { usePanel } from '../usePanel.ts';
import { useSettingsDraft } from './draft_store.ts';
import SettingsHead from './SettingsHead.vue';
import SaveBar from './SaveBar.vue';

const store = useSettingsDraft();
const draft = computed(() => store.draft);
const { locked } = store;
const session = useSession();

// The browser's IANA zones, plus whatever the config holds if the browser
// does not list it, so a saved value is never silently swapped for another.
const zones = computed(() => {
  const all = Intl.supportedValuesOf?.('timeZone') ?? [];
  const current = draft.value?.form.timezone;
  return current && !all.includes(current) ? [...all, current] : all;
});

const { isOpen } = usePanel(PANEL.CHAT, {
  onOpen: store.open,
  onClose: ({ swapping }) => { if (!swapping) useChat().focusTick++; },
  canClose: store.canClose
});
</script>

<template>
  <section :id="PANEL.CHAT" class="set-panel" :class="{ open: isOpen }" aria-label="Chat behaviour">
    <SettingsHead title="Chat behaviour" />
    <div v-if="draft" class="settings-content">
      <section class="set-group">
        <header><h3>General</h3></header>
        <div class="set-grid">
          <div><label for="timezone">Timezone</label>
            <select id="timezone" v-model="draft.form.timezone" :disabled="locked('timezone')"><option value="">Server's timezone</option><option v-for="z in zones" :key="z" :value="z">{{ z }}</option></select>
            <small>The zone the model is told today's date in.</small></div>
          <div><label for="askUserTimeoutSeconds">Question timeout (seconds)</label>
            <input id="askUserTimeoutSeconds" v-model="draft.form.askUserTimeoutSeconds" type="number" min="0" max="86400" :disabled="locked('askUserTimeoutSeconds')">
            <small>How long a question from the model waits before it carries on alone. 0 waits until answered. Tool approval is set on the MCP page.{{ session.personal ? ' A role can set its own under People & roles.' : '' }}</small></div>
          <div v-if="store.admin"><label for="autoTitle">New chat titles</label>
            <select id="autoTitle" v-model="draft.form.autoTitle" :disabled="locked('autoTitle')"><option value="true">Written by the chat's model</option><option value="false">The first message</option></select>
            <small>A model-written title costs one short extra request per new chat.</small></div>
        </div>
      </section>
      <section class="set-group">
        <header><h3>History</h3><p>Keeps long chats fast and cheap by trimming old tool output, then old turns.</p></header>
        <div class="set-grid">
          <div><label for="compactThreshold">Compact history above (tokens)</label><input id="compactThreshold" v-model="draft.form.compactThreshold" type="number" min="0" step="1000" :disabled="locked('compactThreshold')"><small>Old tool results are stubbed past this. 0 turns it off.</small></div>
          <div><label for="keepTurns">Always keep last (turns)</label><input id="keepTurns" v-model="draft.form.keepTurns" type="number" min="1" max="20" :disabled="locked('keepTurns')"><small>Recent turns whose tool results stay in full.</small></div>
          <div><label for="maxHistoryTokens">Hard history limit (tokens)</label><input id="maxHistoryTokens" v-model="draft.form.maxHistoryTokens" type="number" min="0" step="10000" :disabled="locked('maxHistoryTokens')"><small>Past this, the oldest turns stop being sent; they stay visible. 0 turns it off.</small></div>
          <template v-if="store.admin">
            <div><label for="llmCompaction">Dropped turns</label>
              <select id="llmCompaction" v-model="draft.form.llmCompaction" :disabled="locked('llmCompaction')"><option value="true">Summarise with the chat's model</option><option value="false">Drop without a summary</option></select></div>
            <div><label for="compactionMaxTokens">Summary length cap (tokens)</label><input id="compactionMaxTokens" v-model="draft.form.compactionMaxTokens" type="number" min="256" step="256" :disabled="locked('compactionMaxTokens')"><small>Output tokens for that summary request.</small></div>
          </template>
        </div>
      </section>
      <section class="set-group">
        <header><h3>Tool result limits</h3><p>When one large tool result is replaced by a short stub.</p></header>
        <div class="set-grid">
          <div><label for="maxInlineChars">Stub single results above (characters)</label><input id="maxInlineChars" v-model="draft.form.maxInlineChars" type="number" min="0" step="1000" :disabled="locked('maxInlineChars')"><small>The turn that fetched it still reads it whole.</small></div>
          <div><label for="maxTurnChars">Stub even this turn above (characters)</label><input id="maxTurnChars" v-model="draft.form.maxTurnChars" type="number" min="0" step="10000" :disabled="locked('maxTurnChars')"><small>A result this big is stubbed right away, even for the turn that fetched it.</small></div>
          <div><label for="compactMinSaved">Only compact if it saves (characters)</label><input id="compactMinSaved" v-model="draft.form.compactMinSaved" type="number" min="0" step="1000" :disabled="locked('compactMinSaved')"><small>Compacting costs one cache miss, so small savings are skipped.</small></div>
          <div v-if="store.admin"><label for="expandCharBudget">Expand budget (characters)</label><input id="expandCharBudget" v-model="draft.form.expandCharBudget" type="number" min="0" step="1000" :disabled="locked('expandCharBudget')"><small>What one expand_context call may return.</small></div>
        </div>
      </section>
    </div>
    <SaveBar />
  </section>
</template>
