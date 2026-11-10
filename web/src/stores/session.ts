/**
 * What the signed-in person may use, from /api/auth/me. The server enforces
 * every feature on its own routes; this only keeps the UI from offering what
 * would be refused. Hidden, not greyed out: a chat-only user should see a chat
 * app, not a settings app with the settings locked.
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { api } from '../core/api.ts';
import { FEATURE, type Feature } from '../../../shared/features.ts';

export type Me = {
  features: string[], models: string[] | '*',
  user?: { id: string, email?: string, name?: string, status: string } | null,
  authMode?: string, needsSetup?: boolean, canRequest?: boolean, passwordMin?: number,
  logoutUrl?: string | null, customize?: string[], hasPassword?: boolean, instructions?: string | null,
  isAdmin?: boolean, model?: string, modelLabel?: string, modelImages?: boolean, modelTools?: boolean,
  thinking?: { choices: string[], default: string } | null
};

const thinkingKey = (model: string | undefined) => `tinywebui.thinking.${model}`;

export const useSession = defineStore('session', () => {
  const me = ref<Me>({ features: [], models: '*' });
  // localStorage is not reactive; this bumps when a pick is saved so thinkingPick follows.
  const picked = ref(0);

  const features = computed(() => new Set(me.value.features || []));
  const can = (feature: Feature) => features.value.has(feature);
  /** Tier 3: each person picks their own model; otherwise the deployment's one is everyone's. */
  const personal = computed(() => ['multiuser', 'trusted-header'].includes(me.value.authMode || ''));
  /** False only when an admin switched images off for the current model. */
  const modelAcceptsImages = computed(() => me.value.modelImages !== false);
  // Settings also opens for someone whose admin lets them customise their own
  // experience, and for anyone with a password of their own to change.
  const settingsVisible = computed(() => can(FEATURE.SETTINGS) || Boolean(me.value.customize?.length) || Boolean(me.value.hasPassword));
  const canLogout = computed(() => Boolean(me.value.logoutUrl) || me.value.authMode === 'multiuser');

  /**
   * The thinking level to ask for: what this person last picked for the
   * current model, when the model still offers it, else the model's default.
   * Null when the model leaves thinking to the provider. Kept per browser and
   * per model; the server checks it against the model's settings either way.
   */
  const thinkingPick = computed<string | null>(() => {
    void picked.value;
    const t = me.value.thinking;
    if (!t) return null;
    let saved = null;
    try { saved = localStorage.getItem(thinkingKey(me.value.model)); } catch { /* storage blocked */ }
    return saved && t.choices.includes(saved) ? saved : t.default;
  });

  function setThinkingPick(level: string) {
    try { localStorage.setItem(thinkingKey(me.value.model), level); } catch { /* storage blocked: this send still uses it */ }
    picked.value++;
  }

  async function loadAccess(): Promise<Me> {
    try { me.value = await api.get('/api/auth/me'); } catch { /* offline: show nothing extra */ }
    return me.value;
  }

  async function logout() {
    try { await api.post('/api/auth/logout'); } catch { /* going anyway */ }
    // Behind a gateway, the gateway owns the session; ending it is its job.
    if (me.value.logoutUrl) location.href = me.value.logoutUrl;
    else location.reload();
  }

  return { me, can, personal, modelAcceptsImages, settingsVisible, canLogout, thinkingPick, setThinkingPick, loadAccess, logout };
});
