<script setup lang="ts">
/**
 * Create or edit an automation, inline: a name, where results go, a schedule
 * (a preset, with raw cron as the escape hatch) and the instructions.
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { api } from '../../core/api.ts';
import { useChats } from '../../stores/chats.ts';
import { DAYS, WEEK, buildCron, parseCron } from './cron.ts';

// An automation from /api/automations, read field by field.
type Json = any;
const props = defineProps<{ existing: Json | null, chats: { id: string, title?: string }[] }>();
const emit = defineEmits<{ done: [], cancel: [] }>();

const NEW_CHAT = '__new__';
const ZONES = Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : [];
const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const initial = props.existing || {};
const parsed = parseCron(initial.cron || '0 9 * * 1-5');
let presetValue: string = parsed.preset;
if (parsed.preset === 'days') {
  const key = [...parsed.days].sort().join(',');
  presetValue = key === '1,2,3,4,5' ? 'weekdays' : parsed.days.length === 1 ? 'weekly' : 'custom';
}

const name = ref(initial.name || '');
const chatId = ref(initial.chatId || (props.chats.length ? props.chats[0]?.id : NEW_CHAT));
const newChatName = ref('');
const preset = ref(presetValue);
const time = ref('time' in parsed ? parsed.time : '09:00');
const minute = ref(parsed.preset === 'hourly' ? parsed.minute : 0);
const day = ref(parsed.preset === 'days' && parsed.days.length === 1 ? parsed.days[0] as number : 1);
const dom = ref(parsed.preset === 'monthly' ? parsed.dom : 1);
const cron = ref(initial.cron || '0 9 * * 1-5');
const zone = ref(initial.timezone || localZone());
const prompt = ref(initial.prompt || '');
const enabled = ref(initial.enabled ?? true);
const error = ref('');
const saving = ref(false);
const promptEl = ref<HTMLTextAreaElement>();
const nameEl = ref<HTMLInputElement>();

// The schedule's cron follows the preset fields unless it is custom.
watch([preset, time, minute, day, dom], () => {
  const p = preset.value;
  if (p === 'custom') return;
  const t = time.value || '09:00';
  cron.value = (p === 'weekdays' ? buildCron('days', { time: t, days: [1, 2, 3, 4, 5] })
    : p === 'weekly' ? buildCron('days', { time: t, days: [Number(day.value)] })
    : buildCron(p, { time: t, dom: Number(dom.value) || 1, minute: Number(minute.value) || 0 })) || cron.value;
}, { immediate: true });
watch(chatId, (v) => { if (v === NEW_CHAT && !newChatName.value) newChatName.value = name.value.trim(); });

const showTime = computed(() => ['daily', 'weekdays', 'weekly', 'monthly'].includes(preset.value));

/** Grows the instructions box to fit, so long instructions are all visible. */
function autosize() {
  const t = promptEl.value;
  if (!t) return;
  t.style.height = 'auto';
  t.style.height = `${Math.max(t.scrollHeight + 2, 320)}px`;
}
watch(prompt, () => nextTick(autosize));

async function submit() {
  error.value = '';
  saving.value = true;
  const data: Json = { name: name.value.trim(), cron: cron.value.trim(), timezone: zone.value.trim(), prompt: prompt.value, enabled: enabled.value };
  if (chatId.value === NEW_CHAT) data.newChatTitle = newChatName.value.trim();
  else data.chatId = chatId.value;
  try {
    if (props.existing) await api.patch(`/api/automations/${encodeURIComponent(props.existing.id)}`, data);
    else await api.post('/api/automations', data);
  } catch (err) {
    error.value = err.message;
    return;
  } finally {
    saving.value = false;
  }
  emit('done');
  if (data.newChatTitle) useChats().load(); // the new chat belongs in the sidebar too
}

async function remove() {
  if (!props.existing || !confirm(`Delete “${props.existing.name}”? This can't be undone.`)) return;
  try { await api.del(`/api/automations/${encodeURIComponent(props.existing.id)}`); } catch (err) { error.value = err.message; return; }
  emit('done');
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
  if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); emit('cancel'); }
}

onMounted(() => { nextTick(autosize); if (!props.existing) nameEl.value?.focus(); });
</script>

<template>
  <form class="automation-editor" @submit.prevent="submit" @keydown="onKey">
    <div class="automation-row">
      <label class="automation-field"><span class="automation-label">Name</span>
        <input ref="nameEl" v-model="name" required maxlength="120" placeholder="e.g. Morning news digest"></label>
      <label class="automation-field"><span class="automation-label">Post results to</span>
        <select v-model="chatId" required>
          <option v-for="c in chats" :key="c.id" :value="c.id">{{ c.title || c.id }}</option>
          <!-- The server creates a fresh chat, named here. -->
          <option :value="NEW_CHAT">+ New chat…</option>
        </select></label>
      <label v-if="chatId === NEW_CHAT" class="automation-field"><span class="automation-label">New chat name</span>
        <input v-model="newChatName" maxlength="120" placeholder="Name for the new chat" required></label>
    </div>
    <div class="automation-row">
      <label class="automation-field"><span class="automation-label">Repeats</span>
        <select v-model="preset">
          <option value="hourly">Every hour</option><option value="daily">Every day</option><option value="weekdays">Weekdays</option>
          <option value="weekly">Once a week</option><option value="monthly">Once a month</option><option value="custom">Custom (cron)</option>
        </select></label>
      <label v-if="showTime" class="automation-field"><span class="automation-label">At</span><input v-model="time" type="time"></label>
      <label v-if="preset === 'hourly'" class="automation-field"><span class="automation-label">Minute</span><input v-model.number="minute" type="number" min="0" max="59"></label>
      <label v-if="preset === 'weekly'" class="automation-field"><span class="automation-label">On</span>
        <select v-model.number="day"><option v-for="d in WEEK" :key="d" :value="d">{{ DAYS[d] }}</option></select></label>
      <label v-if="preset === 'monthly'" class="automation-field"><span class="automation-label">Day</span><input v-model.number="dom" type="number" min="1" max="28"></label>
      <label v-if="preset === 'custom'" class="automation-field"><span class="automation-label">Cron</span>
        <input v-model="cron" class="mono" required spellcheck="false" placeholder="0 9 * * 1-5"></label>
      <label class="automation-field"><span class="automation-label">Timezone</span>
        <input v-model="zone" required spellcheck="false" list="automation-zones"></label>
      <datalist id="automation-zones"><option v-for="z in ZONES" :key="z" :value="z" /></datalist>
    </div>
    <label class="automation-field"><span class="automation-label">Instructions</span>
      <textarea ref="promptEl" v-model="prompt" required maxlength="12000" placeholder="What should the assistant do each time this runs?" /></label>
    <div v-if="error" class="automation-error" role="alert">{{ error }}</div>
    <div class="automation-actions">
      <button v-if="existing" type="button" class="danger" @click="remove">Delete</button>
      <label class="automation-enabled-row"><input v-model="enabled" type="checkbox"> Enabled</label>
      <span class="grow" />
      <button type="button" @click="emit('cancel')">Cancel</button>
      <button type="submit" class="primary" :disabled="saving">{{ existing ? 'Save' : 'Create' }}</button>
    </div>
  </form>
</template>
