/**
 * The side panels: one open at a time, each toggled by its nav button and
 * closed by Escape or by going back to a chat from the sidebar
 * (closeAllPanels, wired in app.js). Chats are the app; a panel is a detour
 * from them, so the way out is the sidebar toggle that is always on screen,
 * not a close button per panel. This is the only code that opens
 * or closes one; everything else calls openPanel/closePanel/closeAllPanels.
 *
 * Element ids follow the name: the panel is #<name>, its nav button
 * #toggle-<name>. A panel with its own dismiss button (Settings' Close, which
 * also discards edits) names it as closeId.
 */
import { $ } from '../core/dom.js';

export const PANEL = Object.freeze({
  SETTINGS: 'settings',
  MCP: 'mcp',
  INTEGRATIONS: 'integrations',
  AUTOMATIONS: 'automations',
  STATISTICS: 'statistics',
  ADMIN: 'admin'
});

const panels = new Map(); // name -> { onOpen?, onClose?, canClose?, onEscape?, closeId? }
let onAnyOpen = () => {};

const isOpen = (name) => $(name).classList.contains('open');

function show(name, on) {
  $(name).classList.toggle('open', on);
  $(`toggle-${name}`).classList.toggle('active', on);
}

export async function openPanel(name) {
  if (isOpen(name)) return;
  for (const other of panels.keys()) if (other !== name && !closePanel(other, { swapping: true })) return;
  show(name, true);
  onAnyOpen();
  await panels.get(name).onOpen?.();
}

/**
 * `swapping`: another panel is taking its place, so focus belongs there.
 * `force` skips the panel's canClose (it is closing after a save). False when
 * the panel refused, e.g. unsaved edits the person chose to keep.
 */
export function closePanel(name, { swapping = false, force = false } = {}) {
  if (!isOpen(name)) return true;
  if (!force && panels.get(name).canClose?.() === false) return false;
  show(name, false);
  panels.get(name).onClose?.({ swapping });
  return true;
}

/** False when an open panel refused to close (unsaved edits kept). */
export function closeAllPanels() {
  for (const name of panels.keys()) if (!closePanel(name)) return false;
  return true;
}

/**
 * `defs`: { [PANEL.*]: { onOpen?, onClose?({ swapping }), canClose?() -> bool,
 * onEscape?() -> bool (true: handled, stay open), closeId? } }
 * `opts.onAnyOpen()` runs whenever a panel opens -- on mobile the nav buttons
 * live in the drawer, which would otherwise stay over the panel just opened.
 */
export function initPanels(defs, opts = {}) {
  if (opts.onAnyOpen) onAnyOpen = opts.onAnyOpen;
  for (const [name, def] of Object.entries(defs)) {
    panels.set(name, def);
    $(`toggle-${name}`).onclick = () => (isOpen(name) ? closePanel(name) : openPanel(name));
    if (def.closeId) $(def.closeId).onclick = () => closePanel(name);
  }
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    for (const [name, def] of panels) if (isOpen(name) && !def.onEscape?.()) closePanel(name);
  });
}
