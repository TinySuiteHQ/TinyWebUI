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
import { initAppearance, loadThemes } from './panels/appearance.js';
import { applyTheme, builtInThemes, localChoice, setLocalChoice, paintLastTheme } from './themes/theme-loader.js';

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

/**
 * Local auth with no session: sign in, claim a fresh install, accept an
 * invite, or ask for an account. A request makes a pending account; signing
 * in to it lands in the waiting room, which opens the app once it is approved.
 */
async function needsLogin() {
  const me = await loadAccess();
  if (me.user && me.user.status !== 'approved') { waitingRoom(me); return true; }
  if (me.authMode !== 'multiuser' || me.user) return false;
  const invite = new URLSearchParams(location.search).get('invite');
  if (invite) history.replaceState(null, '', location.pathname);
  $('login').hidden = false;
  let mode = me.needsSetup && !invite ? 'setup' : invite ? 'join' : 'signin';

  const TEXT = {
    setup: { title: 'Create the administrator', help: 'The first account owns this installation and can invite others.', submit: 'Create administrator' },
    join: { title: 'Join TinyWebUI', help: 'Create your account using this invitation.', submit: 'Create account' },
    signin: { title: 'TinyWebUI', help: '', submit: 'Sign in' },
    request: { title: 'Request access', help: 'An administrator approves each request before you can start.', submit: 'Send request' }
  };
  const show = (next, note = '') => {
    mode = next;
    const creating = mode !== 'signin';
    $('loginTitle').textContent = TEXT[mode].title;
    $('loginHelp').textContent = TEXT[mode].help;
    $('loginSubmit').textContent = TEXT[mode].submit;
    for (const id of ['loginEmailLabel', 'loginEmail']) $(id).hidden = false;
    $('loginEmail').required = true;
    $('loginPassword').autocomplete = creating ? 'new-password' : 'current-password';
    // A new password is typed twice, and the rule is said before the server has to.
    for (const id of ['loginConfirmLabel', 'loginConfirm', 'loginRule']) $(id).hidden = !creating;
    $('loginConfirm').required = creating;
    for (const id of ['loginNoteLabel', 'loginNote']) $(id).hidden = mode !== 'request';
    $('loginPassword').minLength = creating && me.passwordMin ? me.passwordMin : 0;
    if (creating && me.passwordMin) $('loginRule').textContent = `At least ${me.passwordMin} characters.`;
    // Only between signing in and asking: setup and invitations have one way through.
    const other = mode === 'signin' && me.canRequest ? 'request' : mode === 'request' ? 'signin' : null;
    $('loginSwitch').hidden = !other;
    if (other) {
      $('loginSwitchText').textContent = other === 'request' ? "Don't have an account?" : 'Already have one?';
      $('loginSwitchBtn').textContent = other === 'request' ? 'Request access' : 'Sign in';
      $('loginSwitchBtn').onclick = () => { show(other); $('loginPassword').value = $('loginConfirm').value = ''; };
    }
    $('loginMsg').textContent = note;
    $('loginEmail').focus();
  };
  show(mode);

  const signIn = (account) => api.post('/api/auth/login', account);
  $('loginForm').onsubmit = async (e) => {
    e.preventDefault();
    $('loginMsg').textContent = '';
    if (mode !== 'signin' && $('loginPassword').value !== $('loginConfirm').value) {
      $('loginMsg').textContent = 'The two passwords do not match.';
      $('loginConfirm').select();
      return;
    }
    const account = { email: $('loginEmail').value, password: $('loginPassword').value };
    try {
      if (mode === 'setup') await api.post('/api/auth/setup', account);
      else if (mode === 'join') await api.post('/api/auth/accept-invite', { ...account, token: invite });
      else if (mode === 'signin') await signIn(account);
      else {
        await api.post('/api/auth/request-access', { ...account, note: $('loginNote').value.trim() || null });
        // Straight into the waiting room. The server says "sent" even for an
        // address that already has an account; then this sign-in fails, and
        // the page says no more than that the request went out.
        try { await signIn(account); } catch {
          show('signin', 'Request sent. Once an administrator approves it, sign in with that email and password.');
          return;
        }
      }
      if (mode === 'join') location.href = location.pathname;
      else location.reload();
    } catch (err) {
      $('loginMsg').textContent = err.message;
      if (mode === 'signin') $('loginPassword').select();
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
  initAppearance({ applyTheme, builtInThemes, localChoice, setLocalChoice, isLocked });
  initAutomations();
  initIntegrations();
  initPanels({
    // Themes are re-read on open: an admin may have added or removed one since.
    [PANEL.SETTINGS]: { onOpen: () => { onSettingsOpen(); loadThemes(); }, onClose: onSettingsClose, onEscape: settingsBack, canClose: settingsCanClose, closeId: 'cancel' },
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

// Last visit's theme straight away, sign-in page included; loadThemes() corrects it.
paintLastTheme();

if (!(await needsLogin())) {
  wire();
  newChat();
  // Tools render read-only for non-admins, so they wait on the config, and so
  // does the theme picker, which needs to know whether the default is pinned.
  loadConfig().then(() => {
    loadThemes();
    if (needsSetup()) openPanel(PANEL.SETTINGS);
    return can(FEATURE.TOOLS) && loadTools();
  });
  if (can(FEATURE.MCP)) loadMcp();
  initAdmin();
  loadChats();
  $('input').focus();
}
