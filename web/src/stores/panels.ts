/**
 * The panels: one open at a time, closed by Escape or by going back to a
 * chat. Chats are the app; a panel is a detour from them. Files takes the
 * main column; the rest are sections of the settings dialog, reached from the
 * account menu so the sidebar holds only chats. This is the only code that
 * opens or closes one.
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { FEATURE, type Feature } from '../../../shared/features.ts';
import { useUi } from './ui.ts';
import { useSession } from './session.ts';

export const PANEL = Object.freeze({
  SETTINGS: 'settings',
  MCP: 'mcp',
  INTEGRATIONS: 'integrations',
  AUTOMATIONS: 'automations',
  STATISTICS: 'statistics',
  ADMIN: 'admin',
  FILES: 'files'
} as const);
export type PanelName = typeof PANEL[keyof typeof PANEL];

/** The settings dialog's sections, in rail order. `feature: null` is the settings page, which has its own test. */
export const SETTINGS_SECTIONS: readonly { panel: PanelName, label: string, icon: string, feature: Feature | null }[] = [
  { panel: PANEL.SETTINGS, label: 'General', icon: 'settings', feature: null },
  { panel: PANEL.AUTOMATIONS, label: 'Automations', icon: 'automations', feature: FEATURE.AUTOMATIONS },
  { panel: PANEL.INTEGRATIONS, label: 'Integrations', icon: 'integrations', feature: FEATURE.INTEGRATIONS },
  { panel: PANEL.MCP, label: 'MCP servers', icon: 'mcp', feature: FEATURE.MCP },
  { panel: PANEL.STATISTICS, label: 'Statistics', icon: 'statistics', feature: FEATURE.STATISTICS },
  { panel: PANEL.ADMIN, label: 'Admin', icon: 'admin', feature: FEATURE.ADMIN }
];
const IN_SETTINGS = new Set<PanelName>(SETTINGS_SECTIONS.map((s) => s.panel));
export const inSettings = (name: PanelName | null) => name !== null && IN_SETTINGS.has(name);

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
  /** The section the dialog last showed, so reopening settings lands back there. */
  const lastSection = ref<PanelName | null>(null);
  const sections = computed(() => {
    const session = useSession();
    return SETTINGS_SECTIONS.filter((s) => (s.feature ? session.can(s.feature) : session.settingsVisible));
  });
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
    if (IN_SETTINGS.has(name)) lastSection.value = name;
    // On mobile the nav buttons live in the drawer, which would otherwise stay over the panel.
    useUi().closeDrawer();
    await hooks.get(name)?.onOpen?.();
  }

  /** False when an open panel refused to close. */
  const closeAll = () => (open.value ? closePanel(open.value) : true);
  const toggle = (name: PanelName) => (open.value === name ? closePanel(name) : openPanel(name));

  /** Opens the settings dialog where it was left, or on its first section. */
  function openSettings() {
    const list = sections.value;
    const pick = list.find((s) => s.panel === lastSection.value) || list[0];
    if (pick) return openPanel(pick.panel);
  }

  function escape() {
    if (!open.value) return false;
    if (!hooks.get(open.value)?.onEscape?.()) closePanel(open.value);
    return true;
  }

  return { open, sections, register, openPanel, openSettings, closePanel, closeAll, toggle, escape };
});
