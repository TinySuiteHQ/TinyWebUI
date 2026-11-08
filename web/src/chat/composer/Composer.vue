<script setup lang="ts">
/**
 * The message box. While a turn runs, send becomes stop -- unless something
 * is typed, which the arrow then queues into the turn (Enter steers it,
 * Alt+Enter holds it for later).
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { FEATURE } from '../../../../shared/features.ts';
import { useSession } from '../../stores/session.ts';
import { useConfig } from '../../stores/config.ts';
import { useChat } from '../../stores/chat.ts';
import { useAttachments } from '../../stores/attachments.ts';
import { usePanels, PANEL } from '../../stores/panels.ts';
import { useUi } from '../../stores/ui.ts';
import Icon from '../../ui/Icon.vue';
import Popover from '../../ui/Popover.vue';
import ToolsMenu from './ToolsMenu.vue';
import ModelMenu from './ModelMenu.vue';
import QueueBar from './QueueBar.vue';
import LibraryDialog from './LibraryDialog.vue';
import { LEVEL_NAMES } from './levels.ts';

const session = useSession();
const config = useConfig();
const chat = useChat();
const attachments = useAttachments();
const panels = usePanels();
const ui = useUi();

const input = ref<HTMLTextAreaElement>();
const files = ref<HTMLInputElement>();
const attachBtn = ref<HTMLButtonElement>();
const modelBtn = ref<HTMLButtonElement>();
const popover = ref<InstanceType<typeof Popover>>();
const menu = ref<'tools' | 'model' | null>(null);
const library = ref(false);

// A long paste becomes an attachment instead of a wall of text in the box.
const PASTE_AS_FILE = 2000;

const stop = computed(() => chat.busy && !chat.draft.trim());
const sendLabel = computed(() => (stop.value ? 'Stop' : chat.busy ? 'Queue message (Alt+Enter: hold for later)' : 'Send'));
// The + opens attach and tools; with neither there is nothing in it.
const showAttach = computed(() => session.can(FEATURE.ATTACHMENTS) || session.can(FEATURE.IMAGES) || session.can(FEATURE.TOOLS));
const picker = computed(() => session.can(FEATURE.MODEL_PICKER));
// The provider's own default asks for nothing, so the chip claims nothing.
const thinkTag = computed(() => {
  const level = session.thinkingPick;
  return level && level !== 'provider' ? level : null;
});

function autosize() {
  const el = input.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 190)}px`;
}
watch(() => chat.draft, () => nextTick(autosize));
watch(() => chat.focusTick, () => { if (!ui.narrow) nextTick(() => input.value?.focus()); });

function onKey(e: KeyboardEvent) {
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
  e.preventDefault();
  if (e.altKey && chat.busy) chat.holdInput();
  else chat.send();
}

function stageAll(list: Iterable<File> | null | undefined) {
  for (const f of list || []) {
    const problem = attachments.stage(f);
    if (problem) chat.addError(problem);
  }
}
function onPaste(e: ClipboardEvent) {
  const text = e.clipboardData?.getData('text/plain') || '';
  if (text.length < PASTE_AS_FILE) return;
  e.preventDefault();
  stageAll([new File([text], 'pasted.txt', { type: 'text/plain' })]);
}
function onPicked() {
  stageAll(files.value?.files);
  if (files.value) files.value.value = '';
}

/* ---------- menus ---------- */

function toggleMenu(which: 'tools' | 'model') { menu.value = menu.value === which ? null : which; }
function closeMenu(refocus = false) {
  const btn = menu.value === 'tools' ? attachBtn.value : modelBtn.value;
  menu.value = null;
  if (refocus) btn?.focus();
}
function onDocPointer(e: PointerEvent) {
  if (!menu.value) return;
  const t = e.target as Node;
  const btn = menu.value === 'tools' ? attachBtn.value : modelBtn.value;
  if (!popover.value?.el?.contains(t) && !btn?.contains(t)) closeMenu();
}
function onDocKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && menu.value) { e.preventDefault(); closeMenu(true); }
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocPointer);
  document.addEventListener('keydown', onDocKey);
  if (!ui.narrow) input.value?.focus();
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointer);
  document.removeEventListener('keydown', onDocKey);
});
</script>

<template>
  <form id="form" @submit.prevent="chat.send()" @dragover.prevent @dragenter.prevent @drop.prevent="stageAll($event.dataTransfer?.files)">
    <input ref="files" type="file" multiple hidden @change="onPicked">
    <QueueBar />
    <textarea id="input" ref="input" v-model="chat.draft" rows="1" aria-label="Message"
              :placeholder="chat.busy ? 'Add a message to this turn…' : 'Ask anything…'" @keydown="onKey" @paste="onPaste" />
    <div class="composer-bar">
      <button v-if="showAttach" id="attach" ref="attachBtn" type="button" class="icon-btn" title="Attach files and tools"
              aria-label="Attach files and tools" aria-haspopup="menu" :aria-expanded="menu === 'tools'" @click="toggleMenu('tools')">
        <Icon name="plus" />
      </button>
      <span class="grow" />
      <!-- The chip still says which model answers when it cannot switch; it just stops being a menu. -->
      <button id="modelBtn" ref="modelBtn" type="button" class="model-chip" :class="{ static: !picker }" :disabled="!picker"
              aria-haspopup="menu" :aria-expanded="menu === 'model'" title="Switch model" @click="toggleMenu('model')">
        <span id="status" role="status" aria-live="polite">{{ config.status }}</span>
        <span v-if="thinkTag" class="think-tag" :class="{ off: thinkTag === 'off' }" :title="`Thinking: ${LEVEL_NAMES[thinkTag] || thinkTag}`">
          {{ LEVEL_NAMES[thinkTag] || thinkTag }}
        </span>
        <Icon class="chev" name="chevronDown" />
      </button>
      <button id="send" class="primary" type="submit" :class="{ stop }" :aria-label="sendLabel"
              :title="chat.busy && !stop ? 'Enter: next step · Alt+Enter: hold for later' : ''">
        <Icon :name="stop ? 'stop' : 'send'" />
      </button>
    </div>
    <Popover v-if="menu" ref="popover" :side="menu === 'tools' ? 'left' : 'right'" :centred="chat.empty">
      <ToolsMenu v-if="menu === 'tools'" @pick-files="closeMenu(); files?.click()" @library="closeMenu(); library = true"
                 @manage="closeMenu(); panels.openPanel(PANEL.MCP)" @close="closeMenu()" />
      <ModelMenu v-else @close="closeMenu()" />
    </Popover>
    <LibraryDialog v-if="library" @close="library = false" />
  </form>
</template>
