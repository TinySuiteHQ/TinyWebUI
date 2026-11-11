<script setup lang="ts">
/**
 * The signed-in app: the sidebar, the chat, the Files and MCP pages over it, the
 * settings dialog, and the file viewer over everything. The only wiring: stores do nothing until this starts them.
 */
import { nextTick, onBeforeUnmount, onMounted, watchEffect } from 'vue';
import { FEATURE } from '../../../shared/features.ts';
import { useSession } from '../stores/session.ts';
import { useConfig } from '../stores/config.ts';
import { useChats } from '../stores/chats.ts';
import { useChat } from '../stores/chat.ts';
import { usePanels, PANEL } from '../stores/panels.ts';
import { useUi } from '../stores/ui.ts';
import { useTheme } from '../stores/theme.ts';
import Icon from '../ui/Icon.vue';
import Sidebar from '../chat/sidebar/Sidebar.vue';
import ChatView from '../chat/ChatView.vue';
import SettingsDialog from './SettingsDialog.vue';
import { FileViewer, LAZY, warmUp } from './lazy.ts';
import { useViewer } from '../stores/viewer.ts';

const session = useSession();
const config = useConfig();
const chat = useChat();
const panels = usePanels();
const ui = useUi();
const viewer = useViewer();

// What themes may read (web/public/themes/README.md): the app's state as
// attributes on <html>, never its internals.
watchEffect(() => {
  const root = document.documentElement.dataset;
  root.busy = chat.busy ? 'true' : 'false';
  root.empty = chat.empty ? 'true' : 'false';
});

function onMenu() {
  ui.toggleMenu();
  // This button hides as the sidebar opens; focus goes on to the toggle that took its place.
  if (!ui.narrow) nextTick(() => document.getElementById('side-collapse')?.focus());
}

function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  if (ui.narrow && ui.drawerOpen) { ui.closeDrawer(); return; }
  panels.escape();
}

onMounted(() => {
  ui.init();
  chat.init();
  chat.start();
  useChats().load();
  // The theme the server says, over the one App painted from last visit.
  useTheme().load();
  // Tools render read-only for non-admins, so they wait on the config.
  config.load().then(() => {
    if (config.setupNeeded) panels.openPanel(PANEL.MODELS);
    if (session.can(FEATURE.TOOLS)) config.loadTools();
  });
  if (session.can(FEATURE.MCP)) config.loadMcp();
  document.addEventListener('keydown', onKey);
  // The pages behind the chat are fetched once the browser is idle, so their first open is instant.
  warmUp([...panels.sections.map((s) => s.panel), PANEL.FILES, PANEL.MCP]);
});
onBeforeUnmount(() => document.removeEventListener('keydown', onKey));
</script>

<template>
  <div id="shell" :class="{ 'side-collapsed': ui.collapsed && !ui.narrow }">
    <div id="side-backdrop" :class="{ open: ui.narrow && ui.drawerOpen }" @click="ui.closeDrawer()" />
    <Sidebar />
    <main :class="{ 'empty-chat': chat.empty }" :inert="ui.narrow && ui.drawerOpen">
      <!-- The way back to the sidebar, and so out of every panel: on a phone it
           opens the drawer; on a desktop it shows only while the sidebar is
           collapsed, since the open sidebar carries its own toggle. -->
      <button v-show="ui.narrow || ui.collapsed" id="menu" class="icon-btn" type="button" aria-label="Show sidebar" title="Show sidebar" aria-controls="side"
              :aria-expanded="ui.narrow ? ui.drawerOpen : !ui.collapsed" @click="onMenu">
        <Icon name="sidebar" />
      </button>
      <component :is="LAZY[PANEL.FILES]" v-if="panels.seen.has(PANEL.FILES)" />
      <component :is="LAZY[PANEL.MCP]" v-if="panels.seen.has(PANEL.MCP)" />
      <ChatView />
    </main>
    <SettingsDialog />
    <FileViewer v-if="viewer.current" />
  </div>
</template>
