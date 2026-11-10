<script setup lang="ts">
/**
 * One model in the catalog: who people see, where it is served from, how hard
 * it thinks, and any setting it overrides. Blank overrides inherit the
 * defaults for all models, and say what they would inherit.
 */
import { computed, useId } from 'vue';
import { CACHE_MODES, CACHE_TTLS, LEVELS, OVERRIDES, REASONING_REPLAY, SECTIONS, SENDS, connectorChoices, pickedLevels, type Draft, type ModelDraft, type OverrideSpec } from '../settings/draft.ts';

const props = defineProps<{ draft: Draft, model: ModelDraft, locked: boolean }>();
const emit = defineEmits<{ remove: [] }>();
let lastId = props.model.id;
// Labels name their control; ids are per editor, as two models' editors can be in the page at once.
const uid = useId();
const fid = (key: string) => `${uid}-${key}`;
const checked = (e: Event) => (e.target as HTMLInputElement).checked;

// Renaming the default model's entry keeps it the default.
function renamed() {
  const next = props.model.id.trim();
  if (lastId && props.draft.form.model?.trim() === lastId) props.draft.form.model = next;
  lastId = next;
}
const isDefault = computed(() => Boolean(props.model.id.trim()) && props.draft.form.model?.trim() === props.model.id.trim());
const choices = computed(() => connectorChoices(props.draft, props.model.connector));

const GLOBAL_OPTIONS: Record<string, [string, string][]> = { cacheMode: CACHE_MODES, cacheTtl: CACHE_TTLS, reasoningReplay: REASONING_REPLAY };
/** What a blank override falls back to, read off the global value as it stands in the draft. */
function inherit(spec: OverrideSpec) {
  const v = (props.draft.form[spec.key] || '').trim();
  if (spec.type === 'select') {
    const opts = GLOBAL_OPTIONS[spec.key] || [];
    return `Inherit (${opts.find(([value]) => value === v)?.[1] || v})`;
  }
  if (spec.key === 'systemPrompt') return v ? `Inherit the default prompt: ${v.slice(0, 120)}${v.length > 120 ? '…' : ''}` : 'Inherit (no default prompt)';
  if (spec.type === 'json') return `Inherit: ${v || '{}'}`;
  return `Inherit: ${v || (spec.key === 'maxTokens' ? 'No limit' : 'provider default')}`;
}
/** A select's options, keeping a saved value this page has no option for (set in the file). */
function options(spec: OverrideSpec) {
  const list = spec.options || [];
  const v = props.model.overrides[spec.key];
  return v && !list.some(([value]) => value === v) ? [...list, [v, v] as [string, string]] : list;
}
const bySection = (section: string) => OVERRIDES.filter((s) => s.section === section);

/* ---------- thinking ---------- */

const t = computed(() => props.model.thinking);
const picked = computed(() => pickedLevels(t.value));
// "Send it as" matters only once some level is actually sent.
const sendOff = computed(() => props.locked || picked.value.every((v) => v === 'provider'));
function togglePick(v: string, on: boolean) {
  const picks = new Set(t.value.picks);
  if (on) picks.add(v); else picks.delete(v);
  t.value.picks = [...picks];
}
</script>

<template>
  <div>
    <section class="set-group">
      <header><h3>Model</h3><p>Who people see and where it is served from.</p></header>
      <div class="set-grid">
        <div>
          <label :for="fid('id')">Id</label>
          <input :id="fid('id')" v-model="model.id" placeholder="fast" spellcheck="false" :disabled="locked" @input="renamed">
          <small>Stable handle: roles and preferences name this.</small>
        </div>
        <div>
          <label :for="fid('label')">Label</label>
          <input :id="fid('label')" v-model="model.label" placeholder="Quick" spellcheck="false" :disabled="locked">
          <small>What people see in the model menu.</small>
        </div>
        <div>
          <label :for="fid('desc')">Description</label>
          <input :id="fid('desc')" v-model="model.description" placeholder="Everyday questions" spellcheck="false" :disabled="locked">
          <small>A line under its name in the model menu.</small>
        </div>
        <div>
          <label :for="fid('provider')">Provider model id</label>
          <input :id="fid('provider')" v-model="model.model" placeholder="vendor/model-id" spellcheck="false" :disabled="locked">
          <small>What the API calls it. Blank: the id above.</small>
        </div>
        <div>
          <label :for="fid('conn')">Connection</label>
          <select :id="fid('conn')" v-model="model.connector" :disabled="locked"><option v-for="c in choices" :key="c.value" :value="c.value">{{ c.label }}</option></select>
          <small>Where its requests go.</small>
        </div>
      </div>
    </section>

    <section class="set-group">
      <header><h3>Availability</h3><p>Whether people can pick it, and what it is sent.</p></header>
      <div class="set-grid">
        <div>
          <label :for="fid('enabled')">Enabled</label>
          <span class="set-switch">
            <input :id="fid('enabled')" v-model="model.enabled" type="checkbox" role="switch" :disabled="locked">
            <span class="switch-track" />
          </span>
          <small>People can pick it from the model menu.</small>
        </div>
        <div>
          <label :for="isDefault ? undefined : fid('default')">Default model</label>
          <span v-if="isDefault" class="chip chip-default set-chip">The default</span>
          <button v-else :id="fid('default')" type="button" class="set-inline-btn" :disabled="locked" @click="draft.form.model = model.id.trim()">Make default</button>
          <small>What a new chat starts with, unless a role or the person picks another.</small>
        </div>
        <div>
          <label :for="fid('images')">Images</label>
          <span class="set-switch">
            <input :id="fid('images')" v-model="model.images" type="checkbox" role="switch" :disabled="locked">
            <span class="switch-track" />
          </span>
          <small>People can send it pictures. Off only for models that cannot see.</small>
        </div>
        <div>
          <label :for="fid('tools')">Tools</label>
          <span class="set-switch">
            <input :id="fid('tools')" v-model="model.tools" type="checkbox" role="switch" :disabled="locked">
            <span class="switch-track" />
          </span>
          <small>It can call built-in tools and MCP servers. Off only for models that break on tool calls.</small>
        </div>
      </div>
    </section>

    <template v-for="section in SECTIONS" :key="section">
      <!-- Thinking sits with the other knobs on how the model answers. -->
      <template v-if="section === 'Tools'">
        <section class="set-group">
          <header><h3>Thinking</h3><p>How hard this model thinks before it answers.</p></header>
          <div class="set-grid">
            <div>
              <label :for="fid('level')">Level</label>
              <select :id="fid('level')" v-model="model.thinking.level" :disabled="locked">
                <option v-for="[v, label] in LEVELS" :key="v" :value="v">{{ v === 'provider' ? 'Provider default (send nothing)' : label }}</option>
              </select>
              <small>What every turn uses unless the person picks another.</small>
            </div>
            <div>
              <label :for="fid('send')">Send it as</label>
              <select :id="fid('send')" v-model="model.thinking.send" :disabled="sendOff"><option v-for="[v, label] in SENDS" :key="v" :value="v">{{ label }}</option></select>
              <small>Auto knows OpenRouter and Anthropic; everything else gets reasoning_effort.</small>
            </div>
          </div>
        </section>
        <section class="set-group">
          <header><h3>Levels people may pick</h3><p>Switch on more than one to let people choose from the model menu. With only the default on, the level is fixed.</p></header>
          <div class="set-grid">
            <!-- The default is always one of the choices. -->
            <div v-for="[v, label] in LEVELS" :key="v">
              <label :for="fid(`pick-${v}`)">{{ label }}</label>
              <span class="set-switch">
                <input :id="fid(`pick-${v}`)" type="checkbox" role="switch" :checked="picked.includes(v)" :disabled="locked || v === model.thinking.level"
                       @change="togglePick(v, checked($event))">
                <span class="switch-track" />
              </span>
              <small v-if="v === model.thinking.level">The default level, always offered.</small>
            </div>
          </div>
        </section>
      </template>
      <section class="set-group">
        <header><h3>{{ section }}</h3><p v-if="section === 'Prompt'">Blank fields inherit the defaults for all models.</p></header>
        <div class="set-grid">
          <div v-for="spec in bySection(section)" :key="spec.key" :class="{ 'span-2': spec.type === 'textarea' || spec.type === 'json' }">
            <label :for="fid(spec.key)">{{ spec.label }}</label>
            <select v-if="spec.type === 'select'" :id="fid(spec.key)" v-model="model.overrides[spec.key]" :disabled="locked">
              <option value="">{{ inherit(spec) }}</option>
              <option v-for="[v, label] in options(spec)" :key="v" :value="v">{{ label }}</option>
            </select>
            <textarea v-else-if="spec.type !== 'number'" :id="fid(spec.key)" v-model="model.overrides[spec.key]" :rows="spec.type === 'json' ? 4 : 6"
                      :spellcheck="spec.type !== 'json'" :class="{ mono: spec.type === 'json' }" :placeholder="inherit(spec)" :disabled="locked" />
            <input v-else :id="fid(spec.key)" v-model="model.overrides[spec.key]" type="number" v-bind="spec.attrs" :placeholder="inherit(spec)" :disabled="locked">
            <small v-if="spec.note">{{ spec.note }}</small>
          </div>
        </div>
      </section>
    </template>
    <div class="set-foot"><button type="button" class="danger" :disabled="locked" @click="emit('remove')">Remove model</button></div>
  </div>
</template>
