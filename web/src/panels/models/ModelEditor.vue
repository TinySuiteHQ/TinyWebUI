<script setup lang="ts">
/**
 * One model in the catalog: who people see, where it is served from, how hard
 * it thinks, and any setting it overrides. Blank overrides inherit the
 * defaults for all models, and say what they would inherit.
 */
import { computed } from 'vue';
import { CACHE_MODES, CACHE_TTLS, LEVELS, OVERRIDES, REASONING_REPLAY, SECTIONS, SENDS, connectorChoices, pickedLevels, type Draft, type ModelDraft, type OverrideSpec } from '../settings/draft.ts';

const props = defineProps<{ draft: Draft, model: ModelDraft, locked: boolean }>();
const emit = defineEmits<{ remove: [] }>();
let lastId = props.model.id;

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
        <div><label>Id</label><input v-model="model.id" placeholder="fast" spellcheck="false" :disabled="locked" @input="renamed"><small>Stable handle: roles and preferences name this.</small></div>
        <div><label>Label</label><input v-model="model.label" placeholder="Quick" spellcheck="false" :disabled="locked"><small>What people see.</small></div>
        <div class="span-2"><label>Description</label><input v-model="model.description" placeholder="Everyday questions" spellcheck="false" :disabled="locked"></div>
        <div><label>Provider model id</label><input v-model="model.model" placeholder="vendor/model-id" spellcheck="false" :disabled="locked"><small>Blank: the id above.</small></div>
        <div>
          <label>Connection</label>
          <select v-model="model.connector" :disabled="locked"><option v-for="c in choices" :key="c.value" :value="c.value">{{ c.label }}</option></select>
        </div>
        <div>
          <label>Images</label>
          <label class="inline-check"><input v-model="model.images" type="checkbox" :disabled="locked"> People can send it images</label>
          <small>Off: images are refused for this model. Only for models that cannot see.</small>
        </div>
        <div>
          <label>Tools</label>
          <label class="inline-check"><input v-model="model.tools" type="checkbox" :disabled="locked"> It can call tools and MCP servers</label>
          <small>Off: no tools are offered, whatever people switch on. Only for models that break on tool calls.</small>
        </div>
        <div class="span-2 cfg-actions">
          <label class="inline-check"><input v-model="model.enabled" type="checkbox" :disabled="locked"> Enabled: people can pick it</label>
          <button type="button" :disabled="isDefault || locked" @click="draft.form.model = model.id.trim()">{{ isDefault ? 'Default model' : 'Make default' }}</button>
        </div>
      </div>
    </section>
    <template v-for="section in SECTIONS" :key="section">
      <!-- Thinking sits with the other knobs on how the model answers. -->
      <section v-if="section === 'Tools'" class="set-group">
        <header><h3>Thinking</h3><p>How hard this model thinks before it answers. Tick more than one level to let people switch from the model menu; a single level is fixed.</p></header>
        <div class="set-grid">
          <div>
            <label>Level</label>
            <select v-model="model.thinking.level" :disabled="locked">
              <option v-for="[v, label] in LEVELS" :key="v" :value="v">{{ v === 'provider' ? 'Provider default (send nothing)' : label }}</option>
            </select>
            <small>What every turn uses unless the person picks another.</small>
          </div>
          <div>
            <label>Send it as</label>
            <select v-model="model.thinking.send" :disabled="sendOff"><option v-for="[v, label] in SENDS" :key="v" :value="v">{{ label }}</option></select>
            <small>Auto knows OpenRouter and Anthropic; everything else gets reasoning_effort.</small>
          </div>
          <div class="span-2">
            <label>People may pick</label>
            <div class="cfg-tags">
              <!-- The default is always one of the choices. -->
              <label v-for="[v, label] in LEVELS" :key="v">
                <input type="checkbox" :checked="picked.includes(v)" :disabled="locked || v === model.thinking.level"
                       @change="togglePick(v, ($event.target as HTMLInputElement).checked)"> {{ label }}
              </label>
            </div>
            <small>Only the default ticked: the level is fixed.</small>
          </div>
        </div>
      </section>
      <section class="set-group">
        <header><h3>{{ section }}</h3><p v-if="section === 'Prompt'">Blank fields inherit the defaults for all models.</p></header>
        <div class="set-grid">
          <div v-for="spec in bySection(section)" :key="spec.key" :class="{ 'span-2': spec.type === 'textarea' || spec.type === 'json' }">
            <label>{{ spec.label }}</label>
            <select v-if="spec.type === 'select'" v-model="model.overrides[spec.key]" :disabled="locked">
              <option value="">{{ inherit(spec) }}</option>
              <option v-for="[v, label] in options(spec)" :key="v" :value="v">{{ label }}</option>
            </select>
            <textarea v-else-if="spec.type !== 'number'" v-model="model.overrides[spec.key]" :rows="spec.type === 'json' ? 4 : 6"
                      :spellcheck="spec.type !== 'json'" :class="{ mono: spec.type === 'json' }" :placeholder="inherit(spec)" :disabled="locked" />
            <input v-else v-model="model.overrides[spec.key]" type="number" v-bind="spec.attrs" :placeholder="inherit(spec)" :disabled="locked">
            <small v-if="spec.note">{{ spec.note }}</small>
          </div>
        </div>
      </section>
    </template>
    <div class="set-foot"><button type="button" class="danger" :disabled="locked" @click="emit('remove')">Remove model</button></div>
  </div>
</template>
