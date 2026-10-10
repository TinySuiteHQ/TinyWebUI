/**
 * The side panels: one open at a time, each toggled by its nav button and
 * closed by its close button or Escape. This is the only code that opens or
 * closes one; everything else calls openPanel/closePanel.
 *
 * Element ids follow the name: the panel is #<name>, its nav button
 * #toggle-<name>, its close button #close-<name> unless the panel names another.
 */
import { $ } from '../core/dom.js';

export const PANEL = Object.freeze({
  SETTINGS: 'settings',
  MCP: 'mcp',
  AUTOMATIONS: 'automations',
  STATISTICS: 'statistics',
  ADMIN: 'admin'
});

const panels = new Map(); // name -> { onOpen?, onClose?, canClose?, onEscape?, closeId? }

const isOpen = (name) => $(name).classList.contains('open');

function show(name, on) {
  $(name).classList.toggle('open', on);
  $(`toggle-${name}`).classList.toggle('active', on);
}

export async function openPanel(name) {
  if (isOpen(name)) return;
  for (const other of panels.keys()) if (other !== name && !closePanel(other, { swapping: true })) return;
  show(name, true);
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

/**
 * `defs`: { [PANEL.*]: { onOpen?, onClose?({ swapping }), canClose?() -> bool,
 * onEscape?() -> bool (true: handled, stay open), closeId? } }
 */
export function initPanels(defs) {
  for (const [name, def] of Object.entries(defs)) {
    panels.set(name, def);
    $(`toggle-${name}`).onclick = () => (isOpen(name) ? closePanel(name) : openPanel(name));
    $(def.closeId || `close-${name}`).onclick = () => closePanel(name);
  }
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    for (const [name, def] of panels) if (isOpen(name) && !def.onEscape?.()) closePanel(name);
  });
}
