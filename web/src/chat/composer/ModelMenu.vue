<script setup lang="ts">
/**
 * The model chip's menu: how hard the current model thinks, and which model
 * answers. In tier 3 the pick is personal (saved per person); otherwise it is
 * the deployment's model, for everyone.
 */
import { computed, nextTick, onMounted, ref } from 'vue';
import { api } from '../../core/api.ts';
import { useSession } from '../../stores/session.ts';
import { useConfig } from '../../stores/config.ts';
import { useChat } from '../../stores/chat.ts';
import { LEVEL_NAMES } from './levels.ts';

const emit = defineEmits<{ close: [] }>();
const session = useSession();
const config = useConfig();
const chat = useChat();

// Catalogs longer than this get a search box.
const SEARCH_FROM = 8;

type Model = { id: string, name?: string, description?: string };
const models = ref<Model[] | null>(null);
const supported = ref(true);
// A configured catalog is closed: labels only, no typing arbitrary ids.
const closed = ref(false);
const query = ref('');
const searchEl = ref<HTMLInputElement>();
const listEl = ref<HTMLElement>();

const current = computed(() => (session.personal ? session.me.model : config.model));
const lockedOut = computed(() => !session.personal && config.isLocked('model'));
const thinking = computed(() => session.me.thinking);
const searchable = computed(() => !closed.value || (models.value?.length || 0) > SEARCH_FROM);
// One model in the catalog, and it is the one in use: there is nothing to pick.
const only = computed(() => (!searchable.value && models.value?.length === 1 && models.value[0]?.id === current.value ? models.value[0] : null));

const hits = computed(() => {
  const q = query.value.trim().toLowerCase();
  return (models.value || []).filter((m) => !q || (!closed.value && m.id.toLowerCase().includes(q))
    || (m.name || '').toLowerCase().includes(q) || (m.description || '').toLowerCase().includes(q)).slice(0, 200);
});
// Typing an exact id always works, listed or not: local runtimes and private
// deployments often serve models /models never mentions.
const typed = computed(() => {
  const t = query.value.trim();
  return t && !closed.value && !(models.value || []).some((m) => m.id === t) ? t : '';
});

async function choose(id: string | undefined) {
  emit('close');
  if (!id || id === current.value) return;
  try {
    if (session.personal) await api.post('/api/me/prefs', { model: id });
    else await api.post('/api/config', { model: id });
  } catch (err) { chat.addError(err.message); return; }
  await config.load();
  await session.loadAccess(); // the new model's capabilities and thinking levels
}

function onEnter() {
  // Exact id first, then the top match, then whatever was typed.
  const q = query.value.trim();
  const first = hits.value[0]?.id;
  if (closed.value) { if (first) choose(first); return; }
  choose((models.value || []).some((m) => m.id === q) ? q : first || q);
}

const whoSets = computed(() => (session.personal ? 'set by your administrator' : 'fixed for this model'));

onMounted(async () => {
  if (lockedOut.value) return;
  nextTick(() => searchEl.value?.focus());
  try {
    const out = await api.get('/api/models');
    models.value = out.models || [];
    supported.value = out.supported;
    closed.value = Boolean(out.catalog);
  } catch { models.value = []; supported.value = false; }
  // Without the search box, keyboard focus starts on the model in use.
  if (!searchable.value) nextTick(() => (listEl.value?.querySelector<HTMLElement>('[aria-checked="true"]') || listEl.value?.querySelector<HTMLElement>('.pop-model'))?.focus());
});
</script>

<template>
  <div v-if="thinking" class="pop-think">
    <div class="pop-label">Thinking</div>
    <div v-if="thinking.choices.length < 2" class="pop-note">{{ LEVEL_NAMES[thinking.default] || thinking.default }} · {{ whoSets }}</div>
    <template v-else>
      <div class="think-seg" role="radiogroup" aria-label="Thinking level">
        <button v-for="level in thinking.choices" :key="level" type="button" role="radio" :aria-checked="level === session.thinkingPick"
                @click="session.setThinkingPick(level)">{{ LEVEL_NAMES[level] || level }}</button>
      </div>
      <div class="pop-note">Default leaves it to the provider. Deeper thinking answers harder questions better, and takes longer. Some models ignore it.</div>
    </template>
    <hr class="pop-sep">
  </div>
  <div v-if="lockedOut" class="pop-note">
    {{ config.readOnly ? 'The model is managed by your administrator.' : 'The model is set in code and cannot be switched here.' }}
  </div>
  <template v-else>
    <input v-if="searchable" ref="searchEl" v-model="query" class="pop-search" type="search" aria-label="Search models"
           :placeholder="closed ? 'Search models' : 'Search models or type an id'" @keydown.enter.prevent="onEnter">
    <div v-else class="pop-label">{{ models?.length === 1 ? 'Model' : 'Models' }}</div>
    <div ref="listEl" class="pop-scroll">
      <div v-if="models === null" class="pop-note">Loading models…</div>
      <div v-else-if="only" class="pop-item pop-model pop-only">
        <span class="pop-name">{{ only.name }}</span><span v-if="only.description" class="pop-meta">{{ only.description }}</span>
      </div>
      <template v-else>
        <button v-for="m in hits" :key="m.id" type="button" class="pop-item pop-model" role="menuitemradio"
                :aria-checked="m.id === current" @click="choose(m.id)">
          <span class="pop-name">{{ closed ? m.name : m.id }}</span>
          <span v-if="closed ? m.description : m.name" class="pop-meta">{{ closed ? m.description : m.name }}</span>
        </button>
        <button v-if="typed" type="button" class="pop-item" @click="choose(typed)">Use "{{ typed }}"</button>
        <div v-if="!hits.length && !typed" class="pop-note">
          {{ supported ? 'No models match.' : 'This provider does not list its models. Type a model id and press Enter.' }}
        </div>
      </template>
    </div>
  </template>
</template>
