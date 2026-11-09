<script setup lang="ts">
/**
 * What one role may use (features, models, what its people may personalise)
 * and what its people's chats run with: its own prompt, default model,
 * sampling and approval, over the global values. The admin role always has
 * everything, so only its settings are shown.
 */
import { computed, ref } from 'vue';
import { api } from '../../core/api.ts';
import { FEATURE } from '../../../../shared/features.ts';
import { ROLE_SETTINGS, type RoleSettingKey } from '../../../../shared/settings.ts';
import { useConfig } from '../../stores/config.ts';
import { TOOL_APPROVALS } from '../settings/draft.ts';
import { CUSTOMIZE_INFO, FEATURE_GROUPS, FEATURE_INFO, ROLE_SETTING_INFO, plural, roleLabel } from './admin_words.ts';

// The role and the policy, from /api/admin/policy, read field by field.
type Json = any;
const props = defineProps<{ role: Json, policy: Json }>();
const emit = defineEmits<{ saved: [roles: Json[], message: string], deleted: [roles: Json[]], cancel: [] }>();
const enc = encodeURIComponent;

const locked = computed(() => Boolean(props.policy.locked));
const grouped = new Set(FEATURE_GROUPS.flatMap(([, list]) => list));
// Features the page has no words for still show, so a newer server's are editable too.
const others = computed<string[]>(() => props.policy.features.filter((f: string) => !grouped.has(f) && f !== FEATURE.ADMIN));
const groups = computed(() => [...FEATURE_GROUPS, ...(others.value.length ? [['Other', others.value] as [string, string[]]] : [])]
  .map(([title, list]) => [title, list.filter((f) => props.policy.features.includes(f))] as const));

const features = ref(new Set<string>(props.role.features));
const anyModel = ref(props.role.models === '*');
const models = ref(new Set<string>(props.role.models === '*' ? props.policy.models : props.role.models));
const customize = ref(new Set<string>(props.role.customize));
const msg = ref('');
const saving = ref(false);

function flip(set: Set<string>, v: string, on: boolean) { if (on) set.add(v); else set.delete(v); }
const checked = (e: Event) => (e.target as HTMLInputElement).checked;

/* ---------- settings: blank inherits the global value ---------- */

const config = useConfig();
const NUMBERS = new Set<RoleSettingKey>(['temperature', 'maxTokens', 'maxToolRounds', 'askUserTimeoutSeconds']);
const settings = ref(Object.fromEntries(ROLE_SETTINGS.map((k) => {
  const v = props.role.settings?.[k];
  return [k, v === undefined || v === null ? '' : String(v)];
})) as Record<RoleSettingKey, string>);

// What a blank field falls back to, said where the field is.
const global = computed(() => {
  const c = config.cfg || {};
  return {
    model: c.model || 'none set',
    temperature: c.temperature ?? 'provider default',
    maxTokens: c.maxTokens ?? 'no limit',
    maxToolRounds: c.maxToolRounds ?? '',
    askUserTimeoutSeconds: c.askUserTimeoutSeconds ?? '',
    toolApproval: TOOL_APPROVALS.find(([v]) => v === (c.toolApproval || 'writes'))?.[1] || c.toolApproval
  };
});
// The models this role may start on: what it is allowed, plus the saved pick
// if it is no longer allowed, so it shows rather than silently changing.
const modelChoices = computed(() => {
  const allowed: string[] = anyModel.value ? props.policy.models : props.policy.models.filter((m: string) => models.value.has(m));
  const current = settings.value.model;
  return current && !allowed.includes(current) ? [...allowed, current] : allowed;
});

function settingsBody() {
  const out: Record<string, string | number | null> = {};
  for (const k of ROLE_SETTINGS) {
    // A number input's v-model holds a number once typed in.
    const raw = String(settings.value[k] ?? '');
    if (!raw.trim()) out[k] = null;
    else out[k] = NUMBERS.has(k) ? Number(raw) : k === 'systemPrompt' ? raw : raw.trim();
  }
  return out;
}

async function save() {
  msg.value = '';
  // Features this editor does not offer (admin, set in the files) are kept as they were.
  const kept = props.role.features.filter((f: string) => !FEATURE_INFO[f] && !others.value.includes(f));
  const body: Json = props.role.fixed
    ? { settings: settingsBody() }
    : { features: [...[...features.value].filter((f) => FEATURE_INFO[f] || others.value.includes(f)), ...kept], customize: [...customize.value], settings: settingsBody() };
  if (props.policy.models.length && !props.role.fixed) body.models = anyModel.value ? '*' : [...models.value];
  saving.value = true;
  try {
    const out = await api.patch(`/api/admin/roles/${enc(props.role.name)}`, body);
    emit('saved', out.roles, `Saved ${roleLabel(props.role.name)}.`);
  } catch (err) { msg.value = err.message; } finally { saving.value = false; }
}

async function remove() {
  const moving = props.role.users ? ` ${plural(props.role.users, 'person', 'people')} with it will move to User.` : '';
  if (!confirm(`Delete the ${roleLabel(props.role.name)} role?${moving}`)) return;
  try {
    const out = await api.del(`/api/admin/roles/${enc(props.role.name)}`);
    emit('deleted', out.roles);
  } catch (err) { msg.value = err.message; }
}
</script>

<template>
  <form class="adm-role-edit" @submit.prevent="save">
    <div v-if="!role.fixed" class="adm-feature-groups">
      <fieldset v-for="[title, list] in groups" :key="title" class="adm-fieldset">
        <legend>{{ title }}</legend>
        <div class="adm-checks">
          <label v-for="f in list" :key="f" class="adm-check">
            <input type="checkbox" :checked="features.has(f)" :disabled="locked" @change="flip(features, f, checked($event))">
            <span><b>{{ (FEATURE_INFO[f] || [f, ''])[0] }}</b><small>{{ (FEATURE_INFO[f] || [f, ''])[1] }}</small></span>
          </label>
        </div>
      </fieldset>
    </div>
    <fieldset v-if="policy.models.length && !role.fixed" class="adm-fieldset">
      <legend>Models</legend>
      <label class="adm-check">
        <input v-model="anyModel" type="checkbox" :disabled="locked">
        <span><b>Any model</b><small>Including ones added later</small></span>
      </label>
      <div class="adm-checks adm-models">
        <label v-for="m in policy.models" :key="m" class="adm-check">
          <input type="checkbox" :checked="anyModel || models.has(m)" :disabled="locked || anyModel" @change="flip(models, m, checked($event))">
          <span><b>{{ m }}</b></span>
        </label>
      </div>
    </fieldset>
    <fieldset v-if="!role.fixed" class="adm-fieldset">
      <legend>They may personalise</legend>
      <div class="adm-checks">
        <label v-for="c in policy.customizable" :key="c" class="adm-check">
          <input type="checkbox" :checked="customize.has(c)" :disabled="locked" @change="flip(customize, c, checked($event))">
          <span><b>{{ (CUSTOMIZE_INFO[c] || [c, ''])[0] }}</b><small>{{ (CUSTOMIZE_INFO[c] || [c, ''])[1] }}</small></span>
        </label>
      </div>
    </fieldset>
    <fieldset class="adm-fieldset adm-role-settings">
      <legend>Their chats run with</legend>
      <p class="adm-meta">Blank keeps the global value. A value here wins over the global one and over any model's own.</p>
      <div class="set-grid">
        <div class="span-2"><label :for="`rs-prompt-${role.name}`">{{ ROLE_SETTING_INFO.systemPrompt[0] }}</label>
          <textarea :id="`rs-prompt-${role.name}`" v-model="settings.systemPrompt" rows="5" :disabled="locked" placeholder="Blank: the system prompt from Model defaults" />
          <small>{{ ROLE_SETTING_INFO.systemPrompt[1] }}</small></div>
        <div><label :for="`rs-model-${role.name}`">{{ ROLE_SETTING_INFO.model[0] }}</label>
          <select v-if="policy.models.length" :id="`rs-model-${role.name}`" v-model="settings.model" :disabled="locked">
            <option value="">Global default ({{ global.model }})</option>
            <option v-for="m in modelChoices" :key="m" :value="m">{{ m }}</option>
          </select>
          <input v-else :id="`rs-model-${role.name}`" v-model="settings.model" spellcheck="false" :disabled="locked" :placeholder="`global: ${global.model}`">
          <small>{{ ROLE_SETTING_INFO.model[1] }}</small></div>
        <div><label :for="`rs-approval-${role.name}`">{{ ROLE_SETTING_INFO.toolApproval[0] }}</label>
          <select :id="`rs-approval-${role.name}`" v-model="settings.toolApproval" :disabled="locked">
            <option value="">Global ({{ global.toolApproval }})</option>
            <option v-for="[v, l] in TOOL_APPROVALS" :key="v" :value="v">{{ l }}</option>
          </select>
          <small>{{ ROLE_SETTING_INFO.toolApproval[1] }}</small></div>
        <div><label :for="`rs-temp-${role.name}`">{{ ROLE_SETTING_INFO.temperature[0] }}</label>
          <input :id="`rs-temp-${role.name}`" v-model="settings.temperature" type="number" step="0.1" min="0" max="2" :disabled="locked" :placeholder="`global: ${global.temperature}`"></div>
        <div><label :for="`rs-tokens-${role.name}`">{{ ROLE_SETTING_INFO.maxTokens[0] }}</label>
          <input :id="`rs-tokens-${role.name}`" v-model="settings.maxTokens" type="number" min="1" :disabled="locked" :placeholder="`global: ${global.maxTokens}`"></div>
        <div><label :for="`rs-rounds-${role.name}`">{{ ROLE_SETTING_INFO.maxToolRounds[0] }}</label>
          <input :id="`rs-rounds-${role.name}`" v-model="settings.maxToolRounds" type="number" min="1" max="50" :disabled="locked" :placeholder="`global: ${global.maxToolRounds}`">
          <small>{{ ROLE_SETTING_INFO.maxToolRounds[1] }}</small></div>
        <div><label :for="`rs-ask-${role.name}`">{{ ROLE_SETTING_INFO.askUserTimeoutSeconds[0] }}</label>
          <input :id="`rs-ask-${role.name}`" v-model="settings.askUserTimeoutSeconds" type="number" min="0" max="86400" :disabled="locked" :placeholder="`global: ${global.askUserTimeoutSeconds}`">
          <small>{{ ROLE_SETTING_INFO.askUserTimeoutSeconds[1] }}</small></div>
      </div>
    </fieldset>
    <div class="adm-role-bar">
      <button type="submit" class="primary" :disabled="locked || saving">Save changes</button>
      <button type="button" @click="emit('cancel')">Cancel</button>
      <button v-if="!role.builtin" type="button" class="adm-quiet adm-delete" :disabled="locked" @click="remove">Delete role</button>
    </div>
    <div v-if="msg" class="usage adm-err" role="alert">{{ msg }}</div>
  </form>
</template>
