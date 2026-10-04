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

const panels = new Map(); // name -> { onOpen?, onClose?, closeId? }

const isOpen = (name) => $(name).classList.contains('open');

function show(name, on) {
  $(name).classList.toggle('open', on);
  $(`toggle-${name}`).classList.toggle('active', on);
}

export async function openPanel(name) {
  if (isOpen(name)) return;
  for (const other of panels.keys()) if (other !== name) closePanel(other, { swapping: true });
  show(name, true);
  await panels.get(name).onOpen?.();
}

/** `swapping`: another panel is taking its place, so focus belongs there. */
export function closePanel(name, { swapping = false } = {}) {
  if (!isOpen(name)) return;
  show(name, false);
  panels.get(name).onClose?.({ swapping });
}

/** `defs`: { [PANEL.*]: { onOpen?, onClose?({ swapping }), closeId? } } */
export function initPanels(defs) {
  for (const [name, def] of Object.entries(defs)) {
    panels.set(name, def);
    $(`toggle-${name}`).onclick = () => (isOpen(name) ? closePanel(name) : openPanel(name));
    $(def.closeId || `close-${name}`).onclick = () => closePanel(name);
  }
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') for (const name of panels.keys()) closePanel(name);
  });
}
