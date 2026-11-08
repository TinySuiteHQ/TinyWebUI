<script setup lang="ts">
/** Prompts that run on a schedule and post their result into a chat. */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { api } from '../../core/api.ts';
import { useChat } from '../../stores/chat.ts';
import { PANEL } from '../../stores/panels.ts';
import { usePanel } from '../usePanel.ts';
import { absolute, describeCron, relative } from './cron.ts';
import AutomationForm from './AutomationForm.vue';
import RunHistory from './RunHistory.vue';
import StatusPill from './StatusPill.vue';

// /api/automations, read field by field.
type Json = any;
const chat = useChat();
const snapshot = ref<{ automations: Json[], chats: Json[] }>({ automations: [], chats: [] });
const error = ref('');
// Which form is open: 'new', an automation id, or null. The refresh is
// skipped while one is, so an edit in progress never gets wiped.
const openForm = ref<string | null>(null);
const expanded = ref(new Set<string>());
const busy = ref(new Set<string>());
let request = 0;
let timer: ReturnType<typeof setInterval> | undefined;

async function load() {
  const mine = ++request;
  try {
    const next = await api.get('/api/automations');
    if (mine !== request) return;
    snapshot.value = next;
    error.value = '';
    if (openForm.value && openForm.value !== 'new' && !next.automations.some((a: Json) => a.id === openForm.value)) openForm.value = null;
  } catch (err) {
    if (mine === request) error.value = `Couldn't load automations (${err.message}).`;
  }
}

const { isOpen, close } = usePanel(PANEL.AUTOMATIONS, { onOpen: load });
const url = (a: Json, suffix = '') => `/api/automations/${encodeURIComponent(a.id)}${suffix}`;

function goTo(chatId: string) { close(); chat.openChat(chatId); }

// The switch saves on its own: pausing should not need the editor.
async function setEnabled(a: Json, on: boolean) {
  busy.value.add(a.id);
  try { await api.patch(url(a), { enabled: on }); } catch (err) { alert(err.message); }
  busy.value.delete(a.id);
  await load();
}

async function runNow(a: Json) {
  busy.value.add(a.id);
  try { await api.post(url(a, '/trigger')); } catch (err) { busy.value.delete(a.id); alert(err.message); return; }
  busy.value.delete(a.id);
  goTo(a.chatId);
}

function togglePreview(id: string) {
  if (getSelection()?.toString()) return; // selecting text should not toggle it
  if (expanded.value.has(id)) expanded.value.delete(id); else expanded.value.add(id);
}

async function formDone() { openForm.value = null; await load(); }

// Relative times and statuses go stale; refresh them, never under an open form.
onMounted(() => { timer = setInterval(() => { if (isOpen.value && !openForm.value) load(); }, 30000); });
onBeforeUnmount(() => clearInterval(timer));
</script>

<template>
  <section id="automations" :class="{ open: isOpen }" aria-label="Automations">
    <div class="automation-head">
      <h2>Automations</h2>
      <button v-if="openForm !== 'new'" class="primary" type="button" @click="openForm = 'new'">New automation</button>
    </div>
    <div class="automation-content">
      <section v-if="openForm === 'new'" class="automation-card">
        <h3>New automation</h3>
        <AutomationForm :existing="null" :chats="snapshot.chats" @done="formDone" @cancel="openForm = null" />
      </section>
      <div class="automation-list">
        <div v-if="error" class="automation-empty">{{ error }}</div>
        <div v-else-if="!snapshot.automations.length && openForm !== 'new'" class="automation-empty">
          <p>No automations yet</p>
          <p class="muted">Run a prompt on a schedule and have the result posted into a chat.</p>
        </div>
        <article v-for="a in snapshot.automations" :key="a.id" class="automation-card" :class="{ 'is-paused': !a.enabled }">
          <div class="automation-card-head">
            <div class="automation-title">
              <h3>{{ a.name }}</h3>
              <p class="automation-schedule-line" :title="`cron: ${a.cron}`">{{ describeCron(a.cron) }} · {{ a.timezone }}</p>
            </div>
            <label class="automation-switch" :title="a.enabled ? 'Enabled: click to pause' : 'Paused: click to enable'">
              <input type="checkbox" :checked="a.enabled" :disabled="busy.has(a.id)" :aria-label="`${a.name} enabled`"
                     @change="setEnabled(a, ($event.target as HTMLInputElement).checked)">
              <span class="switch-track" />
            </label>
          </div>
          <div class="automation-facts">
            <span :title="a.nextRunAt ? absolute(a.nextRunAt) : undefined">
              {{ a.enabled ? (a.nextRunAt ? `Next ${relative(a.nextRunAt)}` : 'Not scheduled') : 'Paused' }}
            </span>
            <span class="automation-last">Last run <StatusPill :status="a.lastStatus" />
              <span v-if="a.lastRunAt" :title="absolute(a.lastRunAt)">{{ relative(a.lastRunAt) }}</span></span>
            <button type="button" class="link" title="Open the chat this automation posts to" @click="goTo(a.chatId)">→ {{ a.chatTitle || 'chat' }}</button>
          </div>
          <AutomationForm v-if="openForm === a.id" :existing="a" :chats="snapshot.chats" @done="formDone" @cancel="openForm = null" />
          <template v-else>
            <p class="automation-preview" :class="{ expanded: expanded.has(a.id) }"
               :title="expanded.has(a.id) ? 'Click to collapse' : 'Click to show the full instructions'" @click="togglePreview(a.id)">{{ a.prompt }}</p>
            <div class="automation-actions">
              <button type="button" :disabled="busy.has(a.id)" @click="runNow(a)">{{ busy.has(a.id) ? 'Starting…' : 'Run now' }}</button>
              <button type="button" @click="openForm = a.id">Edit</button>
              <span class="grow" />
              <RunHistory :automation-id="a.id" @open-chat="goTo(a.chatId)" />
            </div>
          </template>
        </article>
      </div>
    </div>
  </section>
</template>
