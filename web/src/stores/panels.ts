/**
 * The full-column panels: one open at a time, toggled from the sidebar and
 * closed by Escape or by going back to a chat. Chats are the app; a panel is
 * a detour from them. This is the only code that opens or closes one.
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { useUi } from './ui.ts';

export const PANEL = Object.freeze({
  SETTINGS: 'settings',
  MCP: 'mcp',
  INTEGRATIONS: 'integrations',
  AUTOMATIONS: 'automations',
  STATISTICS: 'statistics',
  ADMIN: 'admin'
} as const);
export type PanelName = typeof PANEL[keyof typeof PANEL];

export type PanelHooks = {
  onOpen?: () => unknown,
  onClose?: (opts: { swapping: boolean }) => void,
  /** False keeps the panel open (unsaved edits the person chose to keep). */
  canClose?: () => boolean,
  /** True: Escape was handled inside the panel (went back a page), stay open. */
  onEscape?: () => boolean
};

export const usePanels = defineStore('panels', () => {
  const open = ref<PanelName | null>(null);
  const hooks = new Map<PanelName, PanelHooks>();

  /** Each panel registers what it does on open and close when it mounts. */
  const register = (name: PanelName, h: PanelHooks) => { hooks.set(name, h); };

  /**
   * `swapping`: another panel is taking its place, so focus belongs there.
   * `force` skips the panel's canClose (it is closing after a save).
   */
  function closePanel(name: PanelName, { swapping = false, force = false } = {}): boolean {
    if (open.value !== name) return true;
    if (!force && hooks.get(name)?.canClose?.() === false) return false;
    open.value = null;
    hooks.get(name)?.onClose?.({ swapping });
    return true;
  }

  async function openPanel(name: PanelName) {
    if (open.value === name) return;
    if (open.value && !closePanel(open.value, { swapping: true })) return;
    open.value = name;
    // On mobile the nav buttons live in the drawer, which would otherwise stay over the panel.
    useUi().closeDrawer();
    await hooks.get(name)?.onOpen?.();
  }

  /** False when an open panel refused to close. */
  const closeAll = () => (open.value ? closePanel(open.value) : true);
  const toggle = (name: PanelName) => (open.value === name ? closePanel(name) : openPanel(name));

  function escape() {
    if (!open.value) return false;
    if (!hooks.get(open.value)?.onEscape?.()) closePanel(open.value);
    return true;
  }

  return { open, register, openPanel, closePanel, closeAll, toggle, escape };
});
