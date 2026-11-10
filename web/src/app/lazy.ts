/**
 * The pages behind the chat, each its own chunk. First load carries the chat
 * screen only; a page's code comes when it is first opened (the panels
 * store's `seen`), or before that, once the browser is idle (warmUp), so the
 * first open is as quick as the rest.
 */
import { defineAsyncComponent, type Component } from 'vue';
import { PANEL, type PanelName } from '../stores/panels.ts';

type Loader = () => Promise<{ default: Component }>;

const LOADERS: Record<PanelName, Loader> = {
  [PANEL.ACCOUNT]: () => import('../panels/account/AccountPanel.vue'),
  [PANEL.APPEARANCE]: () => import('../panels/appearance/AppearancePanel.vue'),
  [PANEL.AUTOMATIONS]: () => import('../panels/automations/AutomationsPanel.vue'),
  [PANEL.STATISTICS]: () => import('../panels/statistics/StatisticsPanel.vue'),
  [PANEL.DATA]: () => import('../panels/data/DataPanel.vue'),
  [PANEL.MODELS]: () => import('../panels/models/ModelsPanel.vue'),
  [PANEL.MODEL_DEFAULTS]: () => import('../panels/settings/ModelDefaultsPanel.vue'),
  [PANEL.CHAT]: () => import('../panels/settings/ChatBehaviourPanel.vue'),
  [PANEL.ADMIN]: () => import('../panels/admin/AdminPanel.vue'),
  [PANEL.MCP]: () => import('../panels/mcp/McpPanel.vue'),
  [PANEL.FILES]: () => import('../panels/files/FilesPanel.vue')
};

export const LAZY = Object.fromEntries(
  Object.entries(LOADERS).map(([name, load]) => [name, defineAsyncComponent(load)])
) as Record<PanelName, Component>;

const loadViewer: Loader = () => import('../chat/viewer/FileViewer.vue');
export const FileViewer = defineAsyncComponent(loadViewer);

/** Fetches the pages this person can open, once nothing else is going on. */
export function warmUp(names: PanelName[]) {
  const run = () => {
    for (const name of names) LOADERS[name]().catch(() => { /* fetched again on open */ });
    loadViewer().catch(() => {});
  };
  if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 3000 });
  else setTimeout(run, 1500);
}
