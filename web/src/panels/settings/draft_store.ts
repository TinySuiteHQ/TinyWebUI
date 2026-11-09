/**
 * The one unsaved settings draft behind the Models, Model defaults and Chat
 * behaviour pages. It lives beside draft.ts rather than in stores/ because it
 * is built from it, and stores/ may not import panels/ (draft.ts also reads
 * the composer's level names). Moving between those pages keeps the edits;
 * leaving them for anything else asks first.
 */
import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { api } from '../../core/api.ts';
import { useConfig } from '../../stores/config.ts';
import { useSession } from '../../stores/session.ts';
import { PANEL, type PanelName } from '../../stores/panels.ts';
import { buildPatch, changedPatch, fromConfig, keyWords, type Draft } from './draft.ts';

/** The pages that edit the draft: switching between them is not leaving it. */
export const DRAFT_PANELS = new Set<PanelName>([PANEL.MODELS, PANEL.MODEL_DEFAULTS, PANEL.CHAT]);

export const useSettingsDraft = defineStore('settingsDraft', () => {
  const config = useConfig();
  const session = useSession();

  const draft = ref<Draft | null>(null);
  const saveMsg = ref('');
  // The draft as of the last load, to tell whether leaving would lose edits.
  const saved = ref('');

  const cfg = computed(() => config.cfg);
  const readOnly = computed(() => config.readOnly);
  const admin = computed(() => config.admin);
  const frozen = computed(() => Boolean(cfg.value?.frozen));
  const catalogLocked = computed(() => frozen.value || config.lockedKeys.has('models') || config.lockedKeys.has('connectors'));
  const locked = (key: string) => readOnly.value || config.lockedKeys.has(key);
  const why = (key: string) => (frozen.value ? 'frozen deployment: change the config file' : readOnly.value ? 'managed by your administrator' : config.lockedKeys.has(key) ? 'set in code' : undefined);
  const saveDisabled = computed(() => readOnly.value || frozen.value || !draft.value);
  const baseMsg = computed(() => {
    if (config.loadError) return config.loadError;
    if (readOnly.value) return 'managed by your administrator';
    return frozen.value ? 'frozen deployment: settings are managed in its files' : '';
  });

  function snapshot(): string {
    const d = draft.value;
    if (!d) return '';
    try { return JSON.stringify(buildPatch(d, { admin: admin.value, lockedKeys: config.lockedKeys })); } catch { return 'invalid'; }
  }
  const dirty = computed(() => Boolean(draft.value) && snapshot() !== saved.value);

  function reset() {
    if (!cfg.value) return;
    draft.value = fromConfig(cfg.value);
    saved.value = snapshot();
  }

  /** On opening one of its pages: fresh from the server, unless edits are in progress. */
  async function open() {
    if (!dirty.value) saveMsg.value = '';
    await config.load();
    if (!dirty.value) reset();
  }

  // The clashes the person was already told about: saving again with the same ones overwrites them.
  let acknowledged = '';

  async function save() {
    const d = draft.value;
    if (!d) return;
    const opts = () => ({ admin: admin.value, lockedKeys: config.lockedKeys });
    let next;
    try { next = buildPatch(d, opts()); } catch (err) { saveMsg.value = `Couldn't save: ${err.message}`; return; }
    // The config as it is now, which may have moved since the page opened.
    // The draft is dirty, so this reload leaves it alone (see the watch below).
    try { await config.load(); } catch { /* compare against what we have */ }
    let patch = next;
    if (saved.value && saved.value !== 'invalid' && config.cfg) {
      const changed = changedPatch(next, JSON.parse(saved.value), buildPatch(fromConfig(config.cfg), opts()));
      const clash = changed.clashes.join(',');
      if (clash && clash !== acknowledged) {
        acknowledged = clash;
        saveMsg.value = `Changed elsewhere since this page opened: ${changed.clashes.map(keyWords).join(', ')}. Save again to replace those with yours, or Discard to see the current values.`;
        return;
      }
      patch = changed.patch;
    }
    acknowledged = '';
    try { if (Object.keys(patch).length) await api.post('/api/config', patch); } catch (err) { saveMsg.value = `Couldn't save: ${err.message}`; return; }
    await config.load();
    await session.loadAccess(); // a changed model changes what it can take
    await config.loadTools(); // the per-tool "default" labels follow the global settings
    reset();
    // Stays open: the next section is one click away in the rail.
    saveMsg.value = 'Saved';
  }

  /** Leaving the draft pages with edits asks, and on yes goes back to what is saved. */
  function canClose({ to }: { to: PanelName | null }) {
    if ((to && DRAFT_PANELS.has(to)) || !dirty.value) return true;
    if (!window.confirm('Discard unsaved settings changes?')) return false;
    reset();
    return true;
  }

  // A reload of the config while nothing is being edited (startup, a toggle in
  // the composer) refreshes the draft; it never overwrites edits in progress.
  watch(cfg, () => { if (!draft.value || !dirty.value) reset(); }, { immediate: true });
  // A "saved" from before reads wrong once something is edited again.
  watch(dirty, (d) => { if (d) saveMsg.value = ''; });

  return { draft, saveMsg, baseMsg, readOnly, admin, frozen, catalogLocked, saveDisabled, dirty, locked, why, reset, open, save, canClose };
});
