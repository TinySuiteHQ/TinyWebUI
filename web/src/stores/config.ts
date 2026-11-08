/**
 * The deployment's settings as /api/config last returned them, and the tool
 * and MCP lists, shared by the settings panels and the composer's menus.
 * Every loader re-reads from the server: nothing here is edited in place.
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { api } from '../core/api.ts';
import { useSession } from './session.ts';

// /api/config, /api/tools and /api/mcp are wide JSON shapes read field by field.
type Json = any;

export const useConfig = defineStore('config', () => {
  const cfg = ref<Json | null>(null);
  const loadError = ref('');
  const tools = ref<Json | null>(null);
  const toolsError = ref('');
  const mcp = ref<Json | null>(null);
  const mcpError = ref('');

  /** A non-admin sees the deployment's settings but cannot change them. */
  const readOnly = computed(() => Boolean(cfg.value?.readOnly));
  // Keys the server was started with in code; shown read-only and never posted.
  const lockedKeys = computed(() => new Set<string>(cfg.value?.lockedKeys || []));
  /** Whether a setting is pinned in code (or managed by an admin), so the UI cannot change it. */
  const isLocked = (key: string) => readOnly.value || lockedKeys.value.has(key);
  const model = computed<string>(() => cfg.value?.model || '');
  /** Whether this person edits the deployment's endpoints and catalog. */
  const admin = computed(() => Boolean(useSession().me.isAdmin) && !readOnly.value && cfg.value?.baseUrl !== undefined);
  // An admin of an instance whose default model has no endpoint yet: the page
  // opens settings on load, since nothing else works until one is connected.
  const setupNeeded = computed(() => admin.value && cfg.value && !cfg.value.ready);

  /** The model pill's text: your own model in tier 3, else the deployment's, plus what is wrong. */
  const status = computed(() => {
    const c = cfg.value;
    if (!c) return '';
    const me = useSession().me;
    const bits = [useSession().personal && me.model ? me.modelLabel || me.model : c.modelLabel || c.model].filter(Boolean);
    if (!c.ready) bits.push('NO MODEL CONNECTED');
    if (c.mcpErrors?.length) bits.push(`${c.mcpErrors.length} mcp err`);
    return bits.join(' · ');
  });

  async function load() {
    try {
      cfg.value = await api.get('/api/config');
      loadError.value = '';
    } catch (err) {
      loadError.value = `Couldn't load settings (${err.message}).`;
    }
  }

  async function loadTools() {
    try {
      tools.value = await api.get('/api/tools');
      toolsError.value = '';
    } catch (err) {
      toolsError.value = `Couldn't load tools (${err.message}).`;
    }
  }

  async function loadMcp() {
    try {
      mcp.value = await api.get('/api/mcp');
      mcpError.value = '';
    } catch (err) {
      mcpError.value = `Couldn't load MCP config (${err.message}).`;
    }
  }

  return { cfg, loadError, tools, toolsError, mcp, mcpError, readOnly, lockedKeys, isLocked, model, admin, setupNeeded, status, load, loadTools, loadMcp };
});
