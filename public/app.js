/**
 * Entry point: pulls in every UI module (each wires its own DOM listeners on
 * import) and runs the startup sequence.
 */
import { $ } from './dom.js';
import { newChat } from './chat.js';
import { loadChats } from './sidebar.js';
import { loadConfig, loadMcp, loadTools } from './settings.js';
import './attachments.js';
import './automations.js';
import './panels.js';
import { initAdmin } from './admin.js';
import './composer.js';

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
    await fetch('/api/chats/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chats: old })
    });
  } catch { /* the transcripts stay in localStorage; nothing is lost */ }
}

newChat();
// Tools render read-only for non-admins, so they wait on the config.
loadConfig().then(loadTools);
loadMcp();
initAdmin();
migrateLocal().then(loadChats);
$('input').focus();
