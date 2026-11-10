/**
 * The panels: one open at a time, closed by Escape or by going back to a
 * chat. Chats are the app; a panel is a detour from them. Files and MCP take
 * the main column, each with a nav item in the sidebar; the rest are sections
 * of the settings dialog, reached from the account menu. This is the only code
 * that opens or closes one.
 */
import { defineStore } from 'pinia';
import { computed, reactive, ref } from 'vue';
import { FEATURE } from '../../../shared/features.ts';
import { useUi } from './ui.ts';
import { useSession } from './session.ts';

export const PANEL = Object.freeze({
  // 'account' is the sidebar's account button.
  ACCOUNT: 'profile',
  APPEARANCE: 'appearance',
  AUTOMATIONS: 'automations',
  STATISTICS: 'statistics',
  DATA: 'data',
  MODELS: 'models',
  MODEL_DEFAULTS: 'model-defaults',
  CHAT: 'chat-behaviour',
  ADMIN: 'admin',
  MCP: 'mcp',
  FILES: 'files'
} as const);
export type PanelName = typeof PANEL[keyof typeof PANEL];

export type SettingsGroup = 'you' | 'workspace';
type Session = ReturnType<typeof useSession>;
export type SettingsSection = { panel: PanelName, label: string, icon: string, group: SettingsGroup, visible: (s: Session) => boolean };

/** The settings dialog's sections, in rail order: what is yours, then what runs the place. */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  { panel: PANEL.ACCOUNT, label: 'Account', icon: 'account', group: 'you',
    visible: (s) => Boolean(s.me.customize?.includes('instructions') || s.me.hasPassword) },
  { panel: PANEL.APPEARANCE, label: 'Appearance', icon: 'appearance', group: 'you', visible: (s) => s.settingsVisible },
  { panel: PANEL.AUTOMATIONS, label: 'Automations', icon: 'automations', group: 'you', visible: (s) => s.can(FEATURE.AUTOMATIONS) },
  { panel: PANEL.STATISTICS, label: 'Usage', icon: 'statistics', group: 'you', visible: (s) => s.can(FEATURE.STATISTICS) },
  { panel: PANEL.DATA, label: 'Data', icon: 'data', group: 'you', visible: (s) => s.can(FEATURE.CHAT) },
  { panel: PANEL.MODELS, label: 'Models', icon: 'models', group: 'workspace', visible: (s) => s.can(FEATURE.SETTINGS) },
  { panel: PANEL.MODEL_DEFAULTS, label: 'Model defaults', icon: 'defaults', group: 'workspace', visible: (s) => s.can(FEATURE.SETTINGS) },
  { panel: PANEL.CHAT, label: 'Chat behaviour', icon: 'chat', group: 'workspace', visible: (s) => s.can(FEATURE.SETTINGS) },
  { panel: PANEL.ADMIN, label: 'People & roles', icon: 'admin', group: 'workspace', visible: (s) => s.can(FEATURE.ADMIN) }
];
const GROUP_TITLES: Record<SettingsGroup, string> = { you: 'You', workspace: 'Workspace' };
const IN_SETTINGS = new Set<PanelName>(SETTINGS_SECTIONS.map((s) => s.panel));
export const inSettings = (name: PanelName | null) => name !== null && IN_SETTINGS.has(name);

export type PanelHooks = {
  onOpen?: () => unknown,
  onClose?: (opts: { swapping: boolean }) => void,
  /**
   * False keeps the panel open (unsaved edits the person chose to keep).
   * `to` is the panel taking its place, or null when nothing is.
   */
  canClose?: (opts: { to: PanelName | null }) => boolean,
  /** True: Escape was handled inside the panel (went back a page), stay open. */
  onEscape?: () => boolean
};

export const usePanels = defineStore('panels', () => {
  const open = ref<PanelName | null>(null);
  /** The section the dialog last showed, so reopening settings lands back there. */
  const lastSection = ref<PanelName | null>(null);
  const sections = computed(() => {
    const session = useSession();
    return SETTINGS_SECTIONS.filter((s) => s.visible(session));
  });
  /** The rail: each group with its visible sections. A lone group needs no title. */
  const sectionGroups = computed(() => {
    const groups = (Object.keys(GROUP_TITLES) as SettingsGroup[])
      .map((g) => ({ group: g, title: GROUP_TITLES[g], items: sections.value.filter((s) => s.group === g) }))
      .filter((g) => g.items.length);
    return groups.length > 1 ? groups : groups.map((g) => ({ ...g, title: '' }));
  });
  const hooks = new Map<PanelName, PanelHooks>();
  /**
   * The panels opened at least once. A panel's code is fetched and mounted
   * only then (AppShell, SettingsDialog), so first load carries the chat and
   * not every page behind it; once mounted it stays, keeping its state.
   */
  const seen = reactive(new Set<PanelName>());

  /**
   * Each panel registers what it does on open and close when it mounts. One
   * mounted by being opened registers after the open, so it gets its onOpen
   * here instead.
   */
  const register = (name: PanelName, h: PanelHooks) => {
    hooks.set(name, h);
    if (open.value === name) h.onOpen?.();
  };

  /**
   * `to`: the panel taking its place, so focus belongs there.
   * `force` skips the panel's canClose (it is closing after a save).
   */
  function closePanel(name: PanelName, { to = null, force = false }: { to?: PanelName | null, force?: boolean } = {}): boolean {
    if (open.value !== name) return true;
    if (!force && hooks.get(name)?.canClose?.({ to }) === false) return false;
    open.value = null;
    hooks.get(name)?.onClose?.({ swapping: to !== null });
    return true;
  }

  async function openPanel(name: PanelName) {
    if (open.value === name) return;
    if (open.value && !closePanel(open.value, { to: name })) return;
    seen.add(name);
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

  return { open, seen, sections, sectionGroups, register, openPanel, openSettings, closePanel, closeAll, toggle, escape };
});
