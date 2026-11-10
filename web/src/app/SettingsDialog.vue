<script setup lang="ts">
/**
 * Settings as one dialog: a rail of sections, grouped into what is yours and
 * what runs the place, beside whichever is open. The sections are the panels:
 * each one's code is fetched the first time it is opened, then it stays
 * mounted (see LAZY in lazy.ts); the dialog follows the panels store, it never
 * decides on its own.
 */
import { onMounted, ref, watch } from 'vue';
import { usePanels, inSettings, type PanelName } from '../stores/panels.ts';
import { useAdmin } from '../stores/admin.ts';
import { PANEL } from '../stores/panels.ts';
import Icon from '../ui/Icon.vue';
import { LAZY } from './lazy.ts';

const SECTIONS = [PANEL.ACCOUNT, PANEL.APPEARANCE, PANEL.AUTOMATIONS, PANEL.STATISTICS, PANEL.DATA,
  PANEL.MODELS, PANEL.MODEL_DEFAULTS, PANEL.CHAT, PANEL.ADMIN] as const;

const panels = usePanels();
const admin = useAdmin();
const el = ref<HTMLDialogElement>();

function sync(open: PanelName | null) {
  const dlg = el.value;
  if (!dlg) return;
  if (inSettings(open) && !dlg.open) dlg.showModal();
  else if (!inSettings(open) && dlg.open) dlg.close();
}
watch(() => panels.open, sync);
onMounted(() => sync(panels.open));

// Escape reaches the page's own handler (panels.escape: back a page inside a
// section, else close), so the native cancel must not close it underneath.
function onCancel(e: Event) { e.preventDefault(); }
// The browser can still close it (a repeated Escape with no user activation in
// between): put the store in step, or reopen if a section kept unsaved edits.
function onClose() {
  if (!inSettings(panels.open)) return;
  if (!panels.closeAll()) el.value?.showModal();
}
// A click that lands on the dialog itself is on the backdrop around the frame.
function onClick(e: MouseEvent) { if (e.target === el.value) panels.closeAll(); }
</script>

<template>
  <dialog id="settingsDialog" ref="el" aria-labelledby="settingsDialogTitle" @cancel="onCancel" @close="onClose" @click="onClick">
    <div class="settings-frame">
      <nav class="settings-rail" aria-label="Settings sections">
        <div class="settings-rail-head">
          <h2 id="settingsDialogTitle">Settings</h2>
          <button class="icon-btn settings-close" type="button" aria-label="Close settings" title="Close" @click="panels.closeAll()">
            <Icon name="x" />
          </button>
        </div>
        <div class="settings-rail-items">
          <template v-for="g in panels.sectionGroups" :key="g.group">
            <div v-if="g.title" class="settings-rail-group" role="presentation">{{ g.title }}</div>
            <button v-for="s in g.items" :id="`toggle-${s.panel}`" :key="s.panel" class="nav-item" type="button"
                    :class="{ active: panels.open === s.panel }" :aria-current="panels.open === s.panel ? 'page' : undefined"
                    @click="panels.openPanel(s.panel)">
              <Icon :name="s.icon" /><span>{{ s.label }}</span>
              <span v-if="s.panel === PANEL.ADMIN && admin.waiting" class="adm-badge"
                    :title="`${admin.waiting} waiting for approval`">{{ admin.waiting }}</span>
            </button>
          </template>
        </div>
      </nav>
      <div class="settings-body">
        <template v-for="name in SECTIONS" :key="name">
          <component :is="LAZY[name]" v-if="panels.seen.has(name)" />
        </template>
      </div>
    </div>
  </dialog>
</template>
