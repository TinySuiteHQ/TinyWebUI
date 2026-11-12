<script setup lang="ts">
/**
 * Data: everything of this person's as one backup file, and a backup file
 * back in. What the file holds and what import does with it are the server's
 * (server/transfer/backup.ts); this page says so in words and reports back.
 */
import { computed, ref } from 'vue';
import { api } from '../../core/api.ts';
import { FEATURE } from '../../../../shared/features.ts';
import { useSession } from '../../stores/session.ts';
import { useChats } from '../../stores/chats.ts';
import { useTheme } from '../../stores/theme.ts';
import { PANEL } from '../../stores/panels.ts';
import { usePanel } from '../usePanel.ts';
import type { ImportReply } from '../../../../shared/api.ts';


const session = useSession();
const included = computed(() => [
  'Your chats, with tool output and token usage',
  ...(session.can(FEATURE.FOLDERS) ? ['Folders and their instructions'] : []),
  ...(session.can(FEATURE.AUTOMATIONS) ? ['Automations'] : []),
  ...(session.personal ? ['Your instructions and theme'] : [])
]);

const exporting = ref(false);
const exportMsg = ref('');
async function exportAll() {
  exporting.value = true;
  exportMsg.value = '';
  try { await api.download('/api/export', 'tinywebui-backup.json'); }
  catch (err) { exportMsg.value = `Couldn't export: ${err.message}`; }
  finally { exporting.value = false; }
}

const fileInput = ref<HTMLInputElement>();
const importing = ref(false);
const importErr = ref('');
const result = ref<ImportReply | null>(null);

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const summary = computed(() => {
  const r = result.value;
  if (!r) return [];
  const lines = [r.chats ? `Imported ${plural(r.chats, 'chat')}.` : 'No new chats.'];
  if (r.skipped) lines.push(`${plural(r.skipped, 'chat was', 'chats were')} already here and left as they are.`);
  if (r.folders) lines.push(`Added ${plural(r.folders, 'folder')}.`);
  if (r.automations) lines.push(`Added ${plural(r.automations, 'automation')}.`);
  if (r.instructions === 'set') lines.push('Your instructions were set from the backup.');
  if (r.instructions === 'kept') lines.push('Your current instructions were kept; the backup has different ones.');
  return [...lines, ...r.notes];
});

async function onFile() {
  const input = fileInput.value;
  const file = input?.files?.[0];
  if (input) input.value = '';
  if (!file) return;
  importing.value = true;
  importErr.value = '';
  result.value = null;
  try {
    let doc: unknown;
    try { doc = JSON.parse(await file.text()); } catch { throw new Error('that file is not JSON; pick a TinyWebUI backup (.json)'); }
    const r = await api.post<ImportReply>('/api/import', doc);
    result.value = r;
    await useChats().load();
    if (r.instructions === 'set') await session.loadAccess();
    // With sign-in off the theme is the browser's to keep; with it on the server already took it.
    const theme = useTheme();
    if (r.theme !== null && theme.exists(r.theme)) await theme.pick(r.theme);
    else if (session.personal) await theme.load();
  } catch (err) {
    importErr.value = `Couldn't import: ${err.message}`;
  } finally {
    importing.value = false;
  }
}

const { isOpen } = usePanel(PANEL.DATA, { onOpen: () => { exportMsg.value = ''; importErr.value = ''; result.value = null; } });
</script>

<template>
  <section :id="PANEL.DATA" class="set-panel" :class="{ open: isOpen }" aria-label="Data">
    <div class="panel-head"><h2>Data</h2></div>
    <div class="settings-content">
      <section class="set-group">
        <header><h3>Export</h3><p>One file you can keep, or import here or on another TinyWebUI.</p></header>
        <ul class="data-list">
          <li v-for="item in included" :key="item">{{ item }}</li>
        </ul>
        <p class="data-note">Not included: uploaded documents and images, and the server's own settings.</p>
        <div class="pw-actions">
          <button class="primary" type="button" :disabled="exporting" @click="exportAll">{{ exporting ? 'Preparing…' : 'Download backup' }}</button>
          <span class="pw-msg" role="status">{{ exportMsg }}</span>
        </div>
      </section>
      <section class="set-group">
        <header><h3>Import</h3><p>Adds the chats in a backup file to yours. Nothing you have is overwritten.</p></header>
        <p class="data-note">A chat that is already here is skipped, so importing the same file twice changes nothing. Automations come in paused.</p>
        <div class="pw-actions">
          <button type="button" :disabled="importing" @click="fileInput?.click()">{{ importing ? 'Importing…' : 'Import backup…' }}</button>
          <input ref="fileInput" type="file" accept=".json,application/json" hidden @change="onFile">
          <span v-if="importErr" class="pw-msg" role="alert">{{ importErr }}</span>
        </div>
        <ul v-if="summary.length" class="data-list data-result" role="status">
          <li v-for="line in summary" :key="line">{{ line }}</li>
        </ul>
      </section>
    </div>
  </section>
</template>
