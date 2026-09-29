/**
 * Entry point and the page's only wiring. Modules do nothing when imported;
 * each exports an init that attaches its listeners, and anything it needs
 * from another area is handed in here -- so every cross-module call can be
 * traced from this file.
 */
import { $ } from './core/dom.js';
import { api } from './core/api.js';
import { loadAccess, can } from './core/access.js';
import { FEATURE } from './shared/features.js';
import { initChat, newChat, openChat, sendHeld } from './chat/chat.js';
import { initTranscript } from './chat/transcript.js';
import { initQueue } from './chat/queue.js';
import { initSidebar, loadChats } from './chat/sidebar.js';
import { initAttachments } from './chat/attachments.js';
import { initComposer } from './chat/composer.js';
import { PANEL, initPanels, openPanel } from './panels/panels.js';
import {
  initSettings, onSettingsOpen, onSettingsClose,
  loadConfig, loadMcp, loadTools, isLocked, isReadOnly, configuredModel
} from './panels/settings.js';
import { initAutomations, loadAutomations } from './panels/automations.js';
import { loadUsage } from './panels/usage.js';
import { initAdmin, loadAdmin } from './panels/admin.js';

const MIGRATED_KEY = 'tinywebui.chats.migrated';
const OLD_CHATS_KEY = 'tinywebui.chats';

/**
 * Carries transcripts written before the server held them. Runs once; the flag
 * stays behind so a cleared database does not silently re-import stale chats.
 */
async function migrateLocal() {
  if (localStorage.getItem(MIGRATED_KEY)) return;
  let old = [];
  try { old = JSON.parse(localStorage.getItem(OLD_CHATS_KEY)) || []; } catch { /* nothing to carry */ }
  localStorage.setItem(MIGRATED_KEY, '1');
  if (!old.length) return;
  try {
    await api.post('/api/chats/import', { chats: old });
  } catch { /* the transcripts stay in localStorage; nothing is lost */ }
}

/** 'single' mode with no session: show the password screen and stop there. */
async function needsLogin() {
  const me = await loadAccess();
  if (me.authMode !== 'single' || me.user) return false;
  const box = $('login');
  box.hidden = false;
  $('loginPassword').focus();
  $('loginForm').onsubmit = async (e) => {
    e.preventDefault();
    $('loginMsg').textContent = '';
    try {
      await api.post('/api/auth/login', { password: $('loginPassword').value });
      return location.reload();
    } catch (err) {
      $('loginMsg').textContent = err.message;
      $('loginPassword').select();
    }
  };
  return true;
}

function wire() {
  initTranscript({ openChat });
  initQueue({ sendHeld });
  initSidebar({ openChat, newChat });
  initAttachments();
  initChat();
  initComposer({
    config: { load: loadConfig, loadTools, loadMcp, isLocked, isReadOnly, model: configuredModel },
    openMcp: () => openPanel(PANEL.MCP)
  });
  initSettings();
  initAutomations();
  initPanels({
    [PANEL.SETTINGS]: { onOpen: onSettingsOpen, onClose: onSettingsClose, closeId: 'cancel' },
    // The raw editor and the tool list are reloaded on open, so they reflect
    // any toggles made from the composer menu.
    [PANEL.MCP]: { onOpen: () => Promise.all([loadMcp(), loadTools()]) },
    [PANEL.AUTOMATIONS]: { onOpen: loadAutomations },
    [PANEL.STATISTICS]: { onOpen: loadUsage },
    [PANEL.ADMIN]: { onOpen: loadAdmin }
  });
}

if (!(await needsLogin())) {
  wire();
  newChat();
  // Tools render read-only for non-admins, so they wait on the config.
  loadConfig().then(() => can(FEATURE.TOOLS) && loadTools());
  if (can(FEATURE.MCP)) loadMcp();
  initAdmin();
  migrateLocal().then(loadChats);
  $('input').focus();
}
