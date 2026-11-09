<script setup lang="ts">
/**
 * Appearance: the theme on the page, the admin's default for everyone, and
 * themes people import. Changes apply as they are picked; there is no Save.
 */
import { computed, ref } from 'vue';
import { useConfig } from '../../stores/config.ts';
import { useTheme } from '../../stores/theme.ts';

// Select values that are not theme ids: an id never starts with ':'.
const FOLLOW = ':default';
const PLAIN = ':plain';
const toValue = (id: string | null) => (id === null ? FOLLOW : id === '' ? PLAIN : id);
const fromValue = (v: string) => (v === FOLLOW ? null : v === PLAIN ? '' : v);

const config = useConfig();
const theme = useTheme();

const msg = ref('');
const ok = ref(false);
const share = ref(false);
const fileInput = ref<HTMLInputElement>();

const s = computed(() => theme.server);
const canChoose = computed(() => Boolean(s.value?.canChoose));
const setsDefault = computed(() => Boolean(s.value?.multiUser && s.value.canShare));
const defaultLocked = computed(() => Boolean(config.cfg?.frozen) || config.isLocked('theme'));
// An admin without a pick of their own can only import for everyone.
const shareForced = computed(() => setsDefault.value && !canChoose.value);

const pickValue = computed(() => {
  if (!s.value) return PLAIN;
  if (s.value.multiUser) return toValue(theme.exists(theme.choice) ? theme.choice : null);
  return toValue(theme.effectiveId);
});
const defaultValue = computed(() => toValue(theme.defaultId));
const label = (t: { name: string, shared: boolean }) => (s.value?.multiUser && t.shared ? `${t.name} (everyone)` : t.name);

/** The imported theme selected (their own pick, or for an admin without one, the default), when this person may delete it. */
const deletable = computed(() => {
  if (!s.value) return null;
  const id = fromValue(canChoose.value ? pickValue.value : defaultValue.value);
  const t = s.value.custom.find((x) => x.id === id);
  return t && (!t.shared || s.value.canShare) ? t : null;
});

function say(text: string, good = false) {
  msg.value = text;
  ok.value = good;
}

async function onPick(e: Event) {
  const select = e.target as HTMLSelectElement;
  say('');
  try { await theme.pick(fromValue(select.value)); } catch (err) { say(err.message); select.value = pickValue.value; }
}

async function onDefault(e: Event) {
  const select = e.target as HTMLSelectElement;
  say('');
  try {
    await theme.setDefault(fromValue(select.value) ?? '');
    await config.load();
    say('Default saved.', true);
  } catch (err) { say(err.message); select.value = defaultValue.value; }
}

async function onFile() {
  const input = fileInput.value;
  const file = input?.files?.[0];
  if (input) input.value = '';
  if (!file) return;
  say('');
  try {
    const created = await theme.importFile(file, shareForced.value || share.value);
    // Straight onto the page, for whoever may pick it; an admin's for-everyone import waits to be made the default.
    if (canChoose.value) await theme.pick(created.id);
    say(`Imported "${created.name}".`, true);
  } catch (err) { say(err.message); }
}

async function onDelete() {
  const t = deletable.value;
  if (!t) return;
  const everyone = t.shared && s.value?.multiUser;
  if (!window.confirm(everyone ? `Delete "${t.name}" for everyone? Anyone using it goes back to the default.` : `Delete "${t.name}"?`)) return;
  try {
    await theme.remove(t.id);
    say(`Deleted "${t.name}".`, true);
  } catch (err) { say(err.message); }
}
</script>

<template>
  <section v-if="s && (canChoose || setsDefault)" class="set-group mine">
    <header><h3>Appearance</h3><p>Themes change as you pick them; no need to save.</p></header>
    <div class="set-grid">
      <div v-if="canChoose"><label for="theme">Theme</label>
        <select id="theme" :value="pickValue" @change="onPick">
          <option v-if="s.multiUser" :value="FOLLOW">Default ({{ theme.nameOf(theme.defaultId) }})</option>
          <optgroup label="Built-in">
            <option :value="PLAIN">TinyWebUI</option>
            <option v-for="t in theme.themes" :key="t.id" :value="t.id">{{ t.name }}</option>
          </optgroup>
          <optgroup v-if="s.custom.length" label="Custom">
            <option v-for="t in s.custom" :key="t.id" :value="t.id">{{ label(t) }}</option>
          </optgroup>
        </select></div>
      <div v-if="setsDefault"><label for="defaultTheme">Default for everyone</label>
        <!-- Only themes everyone can see can be everyone's default. -->
        <select id="defaultTheme" :value="defaultValue" :disabled="defaultLocked" :title="defaultLocked ? 'set in the config file' : undefined" @change="onDefault">
          <optgroup label="Built-in">
            <option :value="PLAIN">TinyWebUI</option>
            <option v-for="t in theme.themes" :key="t.id" :value="t.id">{{ t.name }}</option>
          </optgroup>
          <optgroup v-if="s.custom.some((t) => t.shared)" label="Custom">
            <option v-for="t in s.custom.filter((x) => x.shared)" :key="t.id" :value="t.id">{{ label(t) }}</option>
          </optgroup>
        </select>
        <small>What people see unless their role may pick their own.</small></div>
    </div>
    <div class="theme-actions">
      <a class="btn" href="/themes/template.css" download="tinywebui-theme.css">Download template</a>
      <button type="button" @click="fileInput?.click()">Import theme…</button>
      <input ref="fileInput" type="file" accept=".css,text/css" hidden @change="onFile">
      <label v-if="setsDefault" class="theme-share"><input type="checkbox" :disabled="shareForced" :checked="shareForced || share" @change="share = ($event.target as HTMLInputElement).checked"> for everyone</label>
      <button v-if="deletable" type="button" @click="onDelete">
        {{ deletable.shared && s.multiUser ? `Delete "${deletable.name}" for everyone` : `Delete "${deletable.name}"` }}
      </button>
      <span class="pw-msg" :class="{ ok }" role="status">{{ msg }}</span>
    </div>
  </section>
</template>
