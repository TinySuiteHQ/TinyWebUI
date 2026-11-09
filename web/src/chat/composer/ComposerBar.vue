<script setup lang="ts">
/**
 * The bar under a message box: the + (attach files, switch tools), the model
 * chip (which model answers, how hard it thinks) and, in the slot, the box's
 * own buttons. Shared by the composer and a question edited in place; `lane`
 * says whose staging list a picked file joins.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { FEATURE } from '../../../../shared/features.ts';
import { useSession } from '../../stores/session.ts';
import { useConfig } from '../../stores/config.ts';
import { useChat } from '../../stores/chat.ts';
import { useAttachments, DOC_ACCEPT, type Lane } from '../../stores/attachments.ts';
import { usePanels, PANEL } from '../../stores/panels.ts';
import Icon from '../../ui/Icon.vue';
import Popover from '../../ui/Popover.vue';
import ToolsMenu from './ToolsMenu.vue';
import ModelMenu from './ModelMenu.vue';
import LibraryDialog from './LibraryDialog.vue';
import CameraDialog from './CameraDialog.vue';
import { levelName } from './levels.ts';

const props = withDefaults(defineProps<{ lane?: Lane, centred?: boolean }>(), { lane: 'compose', centred: false });
const session = useSession();
const config = useConfig();
const chat = useChat();
const attachments = useAttachments();
const panels = usePanels();

const docInput = ref<HTMLInputElement>();
const imageInput = ref<HTMLInputElement>();
const cameraInput = ref<HTMLInputElement>();
const attachBtn = ref<HTMLButtonElement>();
const modelBtn = ref<HTMLButtonElement>();
const popover = ref<InstanceType<typeof Popover>>();
const menu = ref<'tools' | 'model' | null>(null);
const library = ref(false);
const camera = ref(false);
// The composer's own elements keep their ids (themes rely on #status); a copy in a message has none.
const main = computed(() => props.lane === 'compose');

// The + opens attach and tools; with neither there is nothing in it.
const showAttach = computed(() => session.can(FEATURE.ATTACHMENTS) || session.can(FEATURE.IMAGES) || session.can(FEATURE.TOOLS));
const picker = computed(() => session.can(FEATURE.MODEL_PICKER));
// The provider's own default asks for nothing, so the chip claims nothing.
const thinkTag = computed(() => {
  const level = session.thinkingPick;
  return level && level !== 'provider' ? level : null;
});

function stageAll(list: Iterable<File> | null | undefined) {
  for (const f of list || []) {
    const problem = attachments.stage(f, props.lane);
    if (problem) chat.addError(problem);
  }
}
function onPicked(e: Event) {
  const el = e.target as HTMLInputElement;
  stageAll(el.files);
  el.value = '';
}
// A phone's own camera app beats anything a page can draw, so a touch device
// gets it through the capture input; elsewhere a webcam dialog takes the shot.
function takePhoto() {
  if (matchMedia('(pointer: coarse)').matches || !navigator.mediaDevices?.getUserMedia) cameraInput.value?.click();
  else camera.value = true;
}

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
  // Escape closes the open menu first; only then does it reach the box (or the page).
  if (e.key === 'Escape' && menu.value) { e.preventDefault(); e.stopPropagation(); closeMenu(true); }
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocPointer);
  document.addEventListener('keydown', onDocKey, true);
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointer);
  document.removeEventListener('keydown', onDocKey, true);
});

defineExpose({ stageAll });
</script>

<template>
  <input ref="docInput" type="file" multiple hidden :accept="DOC_ACCEPT" @change="onPicked">
  <input ref="imageInput" type="file" multiple hidden accept="image/*" @change="onPicked">
  <input ref="cameraInput" type="file" hidden accept="image/*" capture="environment" @change="onPicked">
  <div class="composer-bar">
    <button v-if="showAttach" :id="main ? 'attach' : undefined" ref="attachBtn" type="button" class="icon-btn composer-attach" title="Attach files and tools"
            aria-label="Attach files and tools" aria-haspopup="menu" :aria-expanded="menu === 'tools'" @click="toggleMenu('tools')">
      <Icon name="plus" />
    </button>
    <span class="grow" />
    <!-- The chip still says which model answers when it cannot switch; it just stops being a menu. -->
    <button :id="main ? 'modelBtn' : undefined" ref="modelBtn" type="button" class="model-chip composer-model" :class="{ static: !picker }" :disabled="!picker"
            aria-haspopup="menu" :aria-expanded="menu === 'model'" title="Switch model" @click="toggleMenu('model')">
      <span :id="main ? 'status' : undefined" class="composer-status" :role="main ? 'status' : undefined" :aria-live="main ? 'polite' : undefined">{{ config.status }}</span>
      <span v-if="thinkTag" class="think-tag" :class="{ off: thinkTag === 'off' }" :title="`Thinking: ${levelName(thinkTag)}`">
        {{ levelName(thinkTag) }}
      </span>
      <Icon class="chev" name="chevronDown" />
    </button>
    <slot />
  </div>
  <Popover v-if="menu" ref="popover" :side="menu === 'tools' ? 'left' : 'right'" :centred="centred">
    <ToolsMenu v-if="menu === 'tools'" @pick-docs="closeMenu(); docInput?.click()" @pick-images="closeMenu(); imageInput?.click()"
               @take-photo="closeMenu(); takePhoto()" @library="closeMenu(); library = true"
               @manage="closeMenu(); panels.openPanel(PANEL.MCP)" @close="closeMenu()" />
    <ModelMenu v-else @close="closeMenu()" />
  </Popover>
  <LibraryDialog v-if="library" :lane="lane" @close="library = false" />
  <CameraDialog v-if="camera" @close="camera = false" @photo="stageAll([$event])" />
</template>
