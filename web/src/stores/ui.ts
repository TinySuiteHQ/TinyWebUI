/**
 * The sidebar's two shapes: on a desktop it is collapsed or not (remembered),
 * on a phone it is a drawer over the chat. One menu button does both.
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';

const COLLAPSE_KEY = 'tinywebui.side.collapsed';
const NARROW = '(max-width: 720px)';

export const useUi = defineStore('ui', () => {
  const narrow = ref(matchMedia(NARROW).matches);
  const drawerOpen = ref(false);
  let saved = false;
  try { saved = Boolean(localStorage.getItem(COLLAPSE_KEY)); } catch { /* per-viewer nicety only */ }
  const collapsed = ref(saved);

  function init() {
    // A resize can move an open drawer onto the desktop layout (or back):
    // close it rather than leave the transcript inert behind nothing.
    matchMedia(NARROW).addEventListener('change', (e) => { narrow.value = e.matches; drawerOpen.value = false; });
  }

  function setCollapsed(on: boolean) {
    collapsed.value = on;
    try { if (on) localStorage.setItem(COLLAPSE_KEY, '1'); else localStorage.removeItem(COLLAPSE_KEY); } catch { /* as above */ }
  }

  const toggleMenu = () => (narrow.value ? (drawerOpen.value = !drawerOpen.value) : setCollapsed(!collapsed.value));
  const closeDrawer = () => { drawerOpen.value = false; };

  return { narrow, drawerOpen, collapsed, init, toggleMenu, closeDrawer };
});
