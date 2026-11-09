<script setup lang="ts">
/**
 * Settings as one dialog: a rail of sections, grouped into what is yours and
 * what runs the place, beside whichever is open. The sections are the panels,
 * mounted for good so their hooks are registered before the first open; the
 * dialog follows the panels store, it never decides on its own.
 */
import { onMounted, ref, watch } from 'vue';
import { usePanels, inSettings, type PanelName } from '../stores/panels.ts';
import { useAdmin } from '../stores/admin.ts';
import { PANEL } from '../stores/panels.ts';
import Icon from '../ui/Icon.vue';
import AccountPanel from '../panels/account/AccountPanel.vue';
import AppearancePanel from '../panels/appearance/AppearancePanel.vue';
import AutomationsPanel from '../panels/automations/AutomationsPanel.vue';
import StatisticsPanel from '../panels/statistics/StatisticsPanel.vue';
import ModelsPanel from '../panels/models/ModelsPanel.vue';
import ModelDefaultsPanel from '../panels/settings/ModelDefaultsPanel.vue';
import ChatBehaviourPanel from '../panels/settings/ChatBehaviourPanel.vue';
import AdminPanel from '../panels/admin/AdminPanel.vue';

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
        <AccountPanel />
        <AppearancePanel />
        <AutomationsPanel />
        <StatisticsPanel />
        <ModelsPanel />
        <ModelDefaultsPanel />
        <ChatBehaviourPanel />
        <AdminPanel />
      </div>
    </div>
  </dialog>
</template>
