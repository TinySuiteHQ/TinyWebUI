/**
 * What the signed-in person may use, from /api/auth/me. The server enforces
 * every feature on its own routes; this only keeps the UI from offering
 * what would be refused. Hidden, not greyed out: a chat-only user should see
 * a chat app, not a settings app with the settings locked.
 */
import { $ } from './dom.js';
import { FEATURE } from './shared/features.js';
import { api } from './api.js';

let me = { features: [], models: '*' };
let features = new Set();

export const can = (feature) => features.has(feature);
export const whoami = () => me;

// Nav items and controls that exist only for one feature.
const GATED = {
  settings: ['toggle-settings'],
  mcp: ['toggle-mcp'],
  automations: ['toggle-automations'],
  statistics: ['toggle-statistics'],
  admin: ['toggle-admin'],
  folders: ['newFolder']
};

export async function loadAccess() {
  try { me = await api.get('/api/auth/me'); } catch { /* offline: show nothing extra */ }
  features = new Set(me.features || []);
  for (const [feature, ids] of Object.entries(GATED)) {
    for (const id of ids) { const node = $(id); if (node) node.hidden = !can(feature); }
  }
  const search = $('chatSearch')?.closest('.search-row');
  if (search) search.hidden = !can(FEATURE.SEARCH);
  // The + button opens attach and tools; with neither there is nothing in it.
  $('attach').hidden = !(can(FEATURE.ATTACHMENTS) || can(FEATURE.IMAGES) || can(FEATURE.TOOLS));
  // The model pill still says which model answers; it just stops being a menu.
  const pill = $('modelBtn');
  pill.disabled = !can(FEATURE.MODEL_PICKER);
  pill.classList.toggle('static', !can(FEATURE.MODEL_PICKER));
  return me;
}
