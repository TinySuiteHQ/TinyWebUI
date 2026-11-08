import { computed, onMounted } from 'vue';
import { usePanels, type PanelName, type PanelHooks } from '../stores/panels.ts';

/** A panel's open state, with its hooks registered for when it opens and closes. */
export function usePanel(name: PanelName, hooks: PanelHooks = {}) {
  const panels = usePanels();
  onMounted(() => panels.register(name, hooks));
  const isOpen = computed(() => panels.open === name);
  return { isOpen, close: (opts?: { force?: boolean }) => panels.closePanel(name, opts) };
}
