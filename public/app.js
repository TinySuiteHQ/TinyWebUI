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

// How often the waiting room asks whether an admin has let this person in.
const GATE_POLL_MS = 15_000;

/**
 * Signed in, not let in (yet): a page that says so and nothing else, instead
 * of an app whose every request would be refused. Re-checks on its own and
 * opens the app the moment an admin approves.
 */
function waitingRoom(me) {
  const disabled = me.user.status === 'disabled';
  $('gate').hidden = false;
  $('gateTitle').textContent = disabled ? 'Access turned off' : 'Waiting for approval';
  $('gateText').textContent = disabled
    ? 'An administrator has turned off your access. If you think that is a mistake, ask them to turn it back on.'
    : 'Your account has been created. An administrator needs to approve it before you can start; this page opens by itself once they do.';
  $('gateWho').textContent = me.user.email || me.user.name ? `Signed in as ${me.user.email || me.user.name}` : '';
  $('gate').classList.toggle('off', disabled);
  if (me.logoutUrl || me.authMode === 'multiuser') {
    $('gateLogout').hidden = false;
    $('gateLogout').onclick = async () => {
      try { await api.post('/api/auth/logout'); } catch { /* going anyway */ }
      if (me.logoutUrl) location.href = me.logoutUrl; else location.reload();
    };
  }
  let timer = null;
  const check = async () => {
    clearTimeout(timer);
    $('gateNote').textContent = 'Checking…';
    let now = null;
    try { now = await api.get('/api/auth/me'); } catch { /* offline for a moment: try again later */ }
    if (now?.user?.status === 'approved') { location.reload(); return; }
    if (now?.user && now.user.status !== me.user.status) { location.reload(); return; }
    $('gateNote').textContent = `Last checked ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    if (!disabled) timer = setTimeout(check, GATE_POLL_MS);
  };
  $('gateCheck').onclick = check;
  $('gateCheck').hidden = disabled;
  if (!disabled) timer = setTimeout(check, GATE_POLL_MS);
}

/** Local auth with no session: sign in, claim a fresh install, or accept an invite. */
async function needsLogin() {
  const me = await loadAccess();
  if (me.user && me.user.status !== 'approved') { waitingRoom(me); return true; }
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
  // A new password is typed twice, and the rule is said before the server has to.
  const creating = setup || joining;
  for (const id of ['loginConfirmLabel', 'loginConfirm', 'loginRule']) $(id).hidden = !creating;
  $('loginConfirm').required = creating;
  if (creating) {
    $('loginPassword').minLength = me.passwordMin;
    $('loginRule').textContent = `At least ${me.passwordMin} characters.`;
  }
  $('loginSubmit').textContent = setup ? 'Create administrator' : joining ? 'Create account' : 'Sign in';
  $('loginEmail').focus();
  $('loginForm').onsubmit = async (e) => {
    e.preventDefault();
    $('loginMsg').textContent = '';
    if (creating && $('loginPassword').value !== $('loginConfirm').value) {
      $('loginMsg').textContent = 'The two passwords do not match.';
      $('loginConfirm').select();
      return;
    }
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
