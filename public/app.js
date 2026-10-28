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
import { initSidebar, loadChats, closeSideDrawer } from './chat/sidebar.js';
import { initAttachments } from './chat/attachments.js';
import { initLibrary } from './chat/library.js';
import { initComposer } from './chat/composer.js';
import { PANEL, initPanels, openPanel, closeAllPanels } from './panels/panels.js';
import {
  initSettings, onSettingsOpen, onSettingsClose, settingsBack, settingsCanClose,
  loadConfig, loadMcp, loadTools, isLocked, isReadOnly, configuredModel, needsSetup
} from './panels/settings.js';
import { initAutomations, loadAutomations } from './panels/automations.js';
import { loadUsage } from './panels/usage.js';
import { initAdmin, loadAdmin } from './panels/admin.js';
import { initIntegrations, loadIntegrations } from './panels/integrations.js';

/** Local auth with no session: sign in, claim a fresh install, or accept an invite. */
async function needsLogin() {
  const me = await loadAccess();
  if (me.authMode !== 'multiuser' || me.user) return false;
  const invite = new URLSearchParams(location.search).get('invite');
  if (invite) history.replaceState(null, '', location.pathname);
  const setup = me.needsSetup && !invite;
  const joining = Boolean(invite);
  const box = $('login');
  box.hidden = false;
  $('loginTitle').textContent = setup ? 'Create the administrator' : joining ? 'Join TinyWebUI' : 'TinyWebUI';
  $('loginHelp').textContent = setup ? 'The first account owns this installation and can invite others.'
    : joining ? 'Create your account using this invitation.' : '';
  for (const id of ['loginEmailLabel', 'loginEmail']) $(id).hidden = false;
  $('loginEmail').required = true;
  $('loginPassword').autocomplete = setup || joining ? 'new-password' : 'current-password';
  $('loginSubmit').textContent = setup ? 'Create administrator' : joining ? 'Create account' : 'Sign in';
  $('loginEmail').focus();
  $('loginForm').onsubmit = async (e) => {
    e.preventDefault();
    $('loginMsg').textContent = '';
    try {
      const account = {
        email: $('loginEmail').value,
        password: $('loginPassword').value
      };
      await api.post(setup ? '/api/auth/setup' : joining ? '/api/auth/accept-invite' : '/api/auth/login',
        setup || joining ? { ...account, ...(joining ? { token: invite } : {}) }
          : { email: account.email, password: account.password });
      if (joining) location.href = location.pathname;
      else location.reload();
    } catch (err) {
      $('loginMsg').textContent = err.message;
      if (!setup && !joining) $('loginPassword').select();
    }
  };
  return true;
}

function wire() {
  initTranscript({ openChat });
  initQueue({ sendHeld });
  // Picking a chat or New from the sidebar is a way out of any open panel,
  // unless it holds unsaved edits the person chose to keep.
  initSidebar({
    openChat: (id) => closeAllPanels() && openChat(id),
    newChat: () => closeAllPanels() && newChat()
  });
  initAttachments();
  initLibrary();
  initChat();
  initComposer({
    config: { load: loadConfig, loadTools, loadMcp, isLocked, isReadOnly, model: configuredModel },
    openMcp: () => openPanel(PANEL.MCP)
  });
  initSettings();
  initAutomations();
  initIntegrations();
  initPanels({
    [PANEL.SETTINGS]: { onOpen: onSettingsOpen, onClose: onSettingsClose, onEscape: settingsBack, canClose: settingsCanClose, closeId: 'cancel' },
    // The raw editor and the tool list are reloaded on open, so they reflect
    // any toggles made from the composer menu.
    [PANEL.MCP]: { onOpen: () => Promise.all([loadMcp(), loadTools()]) },
    [PANEL.AUTOMATIONS]: { onOpen: loadAutomations },
    // Re-read on every open: what a server offers can change between visits.
    [PANEL.INTEGRATIONS]: { onOpen: loadIntegrations },
    [PANEL.STATISTICS]: { onOpen: loadUsage },
    [PANEL.ADMIN]: { onOpen: loadAdmin }
  }, { onAnyOpen: closeSideDrawer });
}

if (!(await needsLogin())) {
  wire();
  newChat();
  // Tools render read-only for non-admins, so they wait on the config.
  loadConfig().then(() => {
    if (needsSetup()) openPanel(PANEL.SETTINGS);
    return can(FEATURE.TOOLS) && loadTools();
  });
  if (can(FEATURE.MCP)) loadMcp();
  initAdmin();
  loadChats();
  $('input').focus();
}
