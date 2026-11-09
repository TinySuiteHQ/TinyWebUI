<script setup lang="ts">
/**
 * The signed-in app: the sidebar, the chat, the Files and MCP pages over it, and the
 * settings dialog. The only wiring: stores do nothing until this starts them.
 */
import { onBeforeUnmount, onMounted, watchEffect } from 'vue';
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
import FilesPanel from '../panels/files/FilesPanel.vue';
import McpPanel from '../panels/mcp/McpPanel.vue';
import SettingsDialog from './SettingsDialog.vue';

const session = useSession();
const config = useConfig();
const chat = useChat();
const panels = usePanels();
const ui = useUi();

// What themes may read (web/public/themes/README.md): the app's state as
// attributes on <html>, never its internals.
watchEffect(() => {
  const root = document.documentElement.dataset;
  root.busy = chat.busy ? 'true' : 'false';
  root.empty = chat.empty ? 'true' : 'false';
});

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
});
onBeforeUnmount(() => document.removeEventListener('keydown', onKey));
</script>

<template>
  <div id="shell" :class="{ 'side-collapsed': ui.collapsed && !ui.narrow }">
    <div id="side-backdrop" :class="{ open: ui.narrow && ui.drawerOpen }" @click="ui.closeDrawer()" />
    <Sidebar />
    <main :class="{ 'empty-chat': chat.empty }" :inert="ui.narrow && ui.drawerOpen">
      <!-- One sidebar toggle at every width: it collapses the desktop sidebar
           and opens the mobile drawer, and it is the way out of every panel. -->
      <button id="menu" class="icon-btn" type="button" aria-label="Toggle sidebar" title="Toggle sidebar" aria-controls="side"
              :aria-expanded="ui.narrow ? ui.drawerOpen : !ui.collapsed" @click="ui.toggleMenu()">
        <Icon name="sidebar" />
      </button>
      <FilesPanel />
      <McpPanel />
      <ChatView />
    </main>
    <SettingsDialog />
  </div>
</template>
