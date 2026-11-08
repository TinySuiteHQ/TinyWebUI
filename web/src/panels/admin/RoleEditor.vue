<script setup lang="ts">
/** What one role may use: features, models, and what its people may personalise. */
import { computed, ref } from 'vue';
import { api } from '../../core/api.ts';
import { FEATURE } from '../../../../shared/features.ts';
import { CUSTOMIZE_INFO, FEATURE_GROUPS, FEATURE_INFO, plural, roleLabel } from './admin_words.ts';

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

async function save() {
  msg.value = '';
  // Features this editor does not offer (admin, set in the files) are kept as they were.
  const kept = props.role.features.filter((f: string) => !FEATURE_INFO[f] && !others.value.includes(f));
  const body: Json = { features: [...[...features.value].filter((f) => FEATURE_INFO[f] || others.value.includes(f)), ...kept], customize: [...customize.value] };
  if (props.policy.models.length) body.models = anyModel.value ? '*' : [...models.value];
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
    <div class="adm-feature-groups">
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
    <fieldset v-if="policy.models.length" class="adm-fieldset">
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
    <fieldset class="adm-fieldset">
      <legend>They may personalise</legend>
      <div class="adm-checks">
        <label v-for="c in policy.customizable" :key="c" class="adm-check">
          <input type="checkbox" :checked="customize.has(c)" :disabled="locked" @change="flip(customize, c, checked($event))">
          <span><b>{{ (CUSTOMIZE_INFO[c] || [c, ''])[0] }}</b><small>{{ (CUSTOMIZE_INFO[c] || [c, ''])[1] }}</small></span>
        </label>
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
