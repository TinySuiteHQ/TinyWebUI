<script setup lang="ts">
/**
 * What one role may use (features, models, what its people may personalise)
 * and what its people's chats run with: its own prompt, default model,
 * sampling and approval over the global values, and the same per model over
 * those. Laid out as a settings page, one setting per row. The admin role
 * always has everything, so only its settings are shown.
 */
import { computed, ref, watch } from 'vue';
import { api } from '../../core/api.ts';
import { FEATURE } from '../../../../shared/features.ts';
import { ROLE_MODEL_SETTINGS, ROLE_SETTINGS, type RoleModelSettingKey, type RoleSettingKey } from '../../../../shared/settings.ts';
import { useConfig } from '../../stores/config.ts';
import { TOOL_APPROVALS } from '../settings/draft.ts';
import { CUSTOMIZE_INFO, FEATURE_GROUPS, FEATURE_INFO, ROLE_SETTING_INFO, plural, roleLabel } from './admin_words.ts';

// The role and the policy, from /api/admin/policy, read field by field.
type Json = any;
const props = defineProps<{ role: Json, policy: Json }>();
const emit = defineEmits<{ saved: [roles: Json[], message: string], deleted: [roles: Json[]], cancel: [] }>();
const enc = encodeURIComponent;
// Ids for label/control pairs; a role name is a safe handle, a model id may not be.
const fid = (...parts: string[]) => `role-${props.role.name}-${parts.join('-').replace(/[^\w-]/g, '_')}`;

const locked = computed(() => Boolean(props.policy.locked));
const grouped = new Set(FEATURE_GROUPS.flatMap(([, list]) => list));
// Features the page has no words for still show, so a newer server's are editable too.
const others = computed<string[]>(() => props.policy.features.filter((f: string) => !grouped.has(f) && f !== FEATURE.ADMIN));
const groups = computed(() => [...FEATURE_GROUPS, ...(others.value.length ? [['Other', others.value] as [string, string[]]] : [])]
  .map(([title, list]) => [title, list.filter((f) => props.policy.features.includes(f))] as const)
  .filter(([, list]) => list.length));

const features = ref(new Set<string>(props.role.features));
const anyModel = ref(props.role.models === '*');
const models = ref(new Set<string>(props.role.models === '*' ? props.policy.models : props.role.models));
const customize = ref(new Set<string>(props.role.customize));
const msg = ref('');
const saving = ref(false);

function flip(set: Set<string>, v: string, on: boolean) { if (on) set.add(v); else set.delete(v); }
const checked = (e: Event) => (e.target as HTMLInputElement).checked;
const info = (table: Record<string, [string, string]>, key: string) => table[key] || [key, ''];

/* ---------- settings: blank inherits ---------- */

const config = useConfig();
const NUMBER_KEYS = ['temperature', 'maxTokens', 'maxToolRounds', 'askUserTimeoutSeconds'] as const;
const MODEL_NUMBER_KEYS = ['temperature', 'maxTokens', 'maxToolRounds'] as const;
const NUMBERS = new Set<RoleSettingKey>(NUMBER_KEYS);
// The same bounds the server checks (access/policy.ts), so the browser stops a bad value first.
const BOUNDS: Record<(typeof NUMBER_KEYS)[number], { min: number, max?: number, step: number }> = {
  temperature: { min: 0, max: 2, step: 0.1 },
  maxTokens: { min: 1, step: 1 },
  maxToolRounds: { min: 1, max: 50, step: 1 },
  askUserTimeoutSeconds: { min: 0, max: 86400, step: 1 }
};
const asText = (v: unknown) => (v === undefined || v === null ? '' : String(v));
const settings = ref(Object.fromEntries(ROLE_SETTINGS.map((k) => [k, asText(props.role.settings?.[k])])) as Record<RoleSettingKey, string>);

type ModelFields = Record<RoleModelSettingKey, string>;
const blankModel = (): ModelFields => Object.fromEntries(ROLE_MODEL_SETTINGS.map((k) => [k, ''])) as ModelFields;
const perModel = ref<Record<string, ModelFields>>(Object.fromEntries(Object.entries<Json>(props.role.modelSettings || {})
  .map(([m, s]) => [m, Object.fromEntries(ROLE_MODEL_SETTINGS.map((k) => [k, asText(s?.[k])])) as ModelFields])));

// What a blank field falls back to, said under the field.
const global = computed(() => {
  const c = config.cfg || {};
  return {
    model: c.model || 'none set',
    systemPrompt: 'the system prompt from Model defaults',
    temperature: c.temperature ?? 'provider default',
    maxTokens: c.maxTokens ?? 'no limit',
    maxToolRounds: c.maxToolRounds ?? '—',
    askUserTimeoutSeconds: c.askUserTimeoutSeconds ?? '—',
    toolApproval: approvalLabel(c.toolApproval || 'writes')
  } as Record<RoleSettingKey, string | number>;
});
function approvalLabel(v: string) { return TOOL_APPROVALS.find(([x]) => x === v)?.[1] || v; }

/** The models this role may use, in catalog order. */
const allowed = computed<string[]>(() => (anyModel.value ? props.policy.models : props.policy.models.filter((m: string) => models.value.has(m))));
// The models this role may start on: what it is allowed, plus the saved pick
// if it is no longer allowed, so it shows rather than silently changing.
const modelChoices = computed(() => {
  const current = settings.value.model;
  return current && !allowed.value.includes(current) ? [...allowed.value, current] : allowed.value;
});

/* ---------- per model ---------- */

const filledCount = (m: string) => Object.values(perModel.value[m] || {}).filter((v) => String(v ?? '').trim()).length;
// Opens on the first model that already has something set, so a saved value is in view.
const pickedModel = ref<string>(Object.keys(perModel.value).find((m) => allowed.value.includes(m)) || allowed.value[0] || '');
// A model switched off above leaves the picker; it lands on one still allowed.
watch(allowed, (list) => { if (!list.includes(pickedModel.value)) pickedModel.value = list[0] || ''; });
// Every model the picker lands on gets fields to type into.
watch(pickedModel, (m) => { if (m && !perModel.value[m]) perModel.value[m] = blankModel(); }, { immediate: true });
const picked = computed<ModelFields>(() => perModel.value[pickedModel.value] || blankModel());
/** What a blank per-model field gets: the role's own value, else the model's own or the global one. */
function inherits(k: RoleModelSettingKey) {
  const own = String(settings.value[k] ?? '').trim();
  if (own) return k === 'systemPrompt' ? "this role's prompt" : `${k === 'toolApproval' ? approvalLabel(own) : own} (this role)`;
  return k === 'systemPrompt' ? "the model's own prompt, else the system prompt" : `the model's own value, else ${global.value[k]}`;
}
function clearModel() { if (pickedModel.value) perModel.value[pickedModel.value] = blankModel(); }

/* ---------- save ---------- */

function valueOf(k: RoleSettingKey, raw: unknown): string | number | null {
  // A number input's v-model holds a number once typed in.
  const text = String(raw ?? '');
  if (!text.trim()) return null;
  return NUMBERS.has(k) ? Number(text) : k === 'systemPrompt' ? text : text.trim();
}
const settingsBody = () => Object.fromEntries(ROLE_SETTINGS.map((k) => [k, valueOf(k, settings.value[k])]));
// Models this role can no longer use drop their settings with them, and a model with nothing set is left out.
const modelSettingsBody = () => Object.fromEntries(Object.entries(perModel.value)
  .filter(([m]) => allowed.value.includes(m) && filledCount(m))
  .map(([m, f]) => [m, Object.fromEntries(ROLE_MODEL_SETTINGS.map((k) => [k, valueOf(k, f[k])]))]));

async function save() {
  msg.value = '';
  // Features this editor does not offer (admin, set in the files) are kept as they were.
  const kept = props.role.features.filter((f: string) => !FEATURE_INFO[f] && !others.value.includes(f));
  const body: Json = props.role.fixed
    ? { settings: settingsBody() }
    : { features: [...[...features.value].filter((f) => FEATURE_INFO[f] || others.value.includes(f)), ...kept], customize: [...customize.value], settings: settingsBody() };
  if (props.policy.models.length) {
    body.modelSettings = modelSettingsBody();
    if (!props.role.fixed) body.models = anyModel.value ? '*' : [...models.value];
  }
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
    <template v-if="!role.fixed">
      <section v-for="[title, list] in groups" :key="title" class="set-group">
        <header><h3>{{ title }}</h3></header>
        <div class="set-grid">
          <div v-for="f in list" :key="f">
            <label :for="fid('f', f)">{{ info(FEATURE_INFO, f)[0] }}</label>
            <span class="set-switch">
              <input :id="fid('f', f)" type="checkbox" role="switch" :checked="features.has(f)" :disabled="locked" @change="flip(features, f, checked($event))">
              <span class="switch-track" />
            </span>
            <small>{{ info(FEATURE_INFO, f)[1] }}</small>
          </div>
        </div>
      </section>

      <section v-if="policy.models.length" class="set-group">
        <header><h3>Models</h3><p>Which models their chats can use.</p></header>
        <div class="set-grid">
          <div>
            <label :for="fid('any')">Any model</label>
            <span class="set-switch">
              <input :id="fid('any')" v-model="anyModel" type="checkbox" role="switch" :disabled="locked">
              <span class="switch-track" />
            </span>
            <small>Including ones added later.</small>
          </div>
          <div v-for="m in policy.models" :key="m">
            <label :for="fid('m', m)" class="adm-model-id">{{ m }}</label>
            <span class="set-switch">
              <input :id="fid('m', m)" type="checkbox" role="switch" :checked="anyModel || models.has(m)" :disabled="locked || anyModel"
                     @change="flip(models, m, checked($event))">
              <span class="switch-track" />
            </span>
          </div>
        </div>
      </section>

      <section class="set-group">
        <header><h3>They may personalise</h3></header>
        <div class="set-grid">
          <div v-for="c in policy.customizable" :key="c">
            <label :for="fid('c', c)">{{ info(CUSTOMIZE_INFO, c)[0] }}</label>
            <span class="set-switch">
              <input :id="fid('c', c)" type="checkbox" role="switch" :checked="customize.has(c)" :disabled="locked" @change="flip(customize, c, checked($event))">
              <span class="switch-track" />
            </span>
            <small>{{ info(CUSTOMIZE_INFO, c)[1] }}</small>
          </div>
        </div>
      </section>
    </template>

    <section class="set-group">
      <header><h3>Their chats run with</h3><p>Blank keeps the global value. A value here wins over the global one and over any model's own.</p></header>
      <div class="set-grid">
        <div class="span-2">
          <label :for="fid('prompt')">{{ ROLE_SETTING_INFO.systemPrompt[0] }}</label>
          <textarea :id="fid('prompt')" v-model="settings.systemPrompt" rows="5" :disabled="locked" />
          <small>{{ ROLE_SETTING_INFO.systemPrompt[1] }}</small>
        </div>
        <div>
          <label :for="fid('model')">{{ ROLE_SETTING_INFO.model[0] }}</label>
          <select v-if="policy.models.length" :id="fid('model')" v-model="settings.model" :disabled="locked">
            <option value="">Global default ({{ global.model }})</option>
            <option v-for="m in modelChoices" :key="m" :value="m">{{ m }}</option>
          </select>
          <input v-else :id="fid('model')" v-model="settings.model" spellcheck="false" :disabled="locked">
          <small>{{ ROLE_SETTING_INFO.model[1] }}</small>
        </div>
        <div>
          <label :for="fid('approval')">{{ ROLE_SETTING_INFO.toolApproval[0] }}</label>
          <select :id="fid('approval')" v-model="settings.toolApproval" :disabled="locked">
            <option value="">Global ({{ global.toolApproval }})</option>
            <option v-for="[v, l] in TOOL_APPROVALS" :key="v" :value="v">{{ l }}</option>
          </select>
          <small>{{ ROLE_SETTING_INFO.toolApproval[1] }}</small>
        </div>
        <div v-for="k in NUMBER_KEYS" :key="k">
          <label :for="fid(k)">{{ ROLE_SETTING_INFO[k][0] }}</label>
          <input :id="fid(k)" v-model="settings[k]" type="number" :disabled="locked" :step="BOUNDS[k].step" :min="BOUNDS[k].min" :max="BOUNDS[k].max">
          <small>{{ ROLE_SETTING_INFO[k][1] }} Blank: {{ global[k] }}.</small>
        </div>
      </div>
    </section>

    <section v-if="policy.models.length && allowed.length" class="set-group">
      <header><h3>Per model</h3><p>For one model, over the settings above. Blank keeps the value above.</p></header>
      <div class="set-grid">
        <div>
          <label :for="fid('pm')">Model</label>
          <select :id="fid('pm')" v-model="pickedModel">
            <option v-for="m in allowed" :key="m" :value="m">{{ m }}{{ filledCount(m) ? ` (${plural(filledCount(m), 'setting')})` : '' }}</option>
          </select>
          <small>The model the settings below apply to. Models with settings show how many.</small>
        </div>
        <div class="span-2">
          <label :for="fid('pm-prompt')">{{ ROLE_SETTING_INFO.systemPrompt[0] }}</label>
          <textarea :id="fid('pm-prompt')" v-model="picked.systemPrompt" rows="4" :disabled="locked" />
          <small>Replaces the prompt for this role on {{ pickedModel }}. Blank: {{ inherits('systemPrompt') }}.</small>
        </div>
        <div>
          <label :for="fid('pm-approval')">{{ ROLE_SETTING_INFO.toolApproval[0] }}</label>
          <select :id="fid('pm-approval')" v-model="picked.toolApproval" :disabled="locked">
            <option value="">Keep ({{ inherits('toolApproval') }})</option>
            <option v-for="[v, l] in TOOL_APPROVALS" :key="v" :value="v">{{ l }}</option>
          </select>
          <small>{{ ROLE_SETTING_INFO.toolApproval[1] }}</small>
        </div>
        <div v-for="k in MODEL_NUMBER_KEYS" :key="k">
          <label :for="fid('pm', k)">{{ ROLE_SETTING_INFO[k][0] }}</label>
          <input :id="fid('pm', k)" v-model="picked[k]" type="number" :disabled="locked" :step="BOUNDS[k].step" :min="BOUNDS[k].min" :max="BOUNDS[k].max">
          <small>Blank: {{ inherits(k) }}.</small>
        </div>
        <div v-if="filledCount(pickedModel)" class="span-2">
          <button type="button" class="adm-quiet" :disabled="locked" @click="clearModel">Clear {{ pickedModel }}'s settings</button>
        </div>
      </div>
    </section>

    <div class="adm-role-bar">
      <button type="submit" class="primary" :disabled="locked || saving">Save changes</button>
      <button type="button" @click="emit('cancel')">Cancel</button>
      <button v-if="!role.builtin" type="button" class="adm-quiet adm-delete" :disabled="locked" @click="remove">Delete role</button>
    </div>
    <div v-if="msg" class="usage adm-err" role="alert">{{ msg }}</div>
  </form>
</template>
