<script setup lang="ts">
/**
 * Files: everything the person has attached, across every chat, in one list,
 * newest first, with its type in a column. Documents and images still come
 * from two places and are reused differently: a document is stored once with
 * its text and goes into another chat as is; an image lives on the message
 * that sent it, so reusing one stages its bytes again.
 * Read fresh on every open; nothing else reads this, so it stays local.
 */
import { computed, ref } from 'vue';
import { api } from '../../core/api.ts';
import { fileKind, IMAGE_KIND, type FileKind } from '../../core/file_kind.ts';
import { FEATURE } from '../../../../shared/features.ts';
import { useSession } from '../../stores/session.ts';
import { useChat } from '../../stores/chat.ts';
import { useAttachments } from '../../stores/attachments.ts';
import { usePanels, PANEL } from '../../stores/panels.ts';
import { useViewer } from '../../stores/viewer.ts';
import type { Doc } from '../../model/turn_model.ts';
import Icon from '../../ui/Icon.vue';
import { usePanel } from '../usePanel.ts';

type DocRow = Doc & { mime: string | null, created_at: number, chatId: string, chatTitle: string };
type ImageRow = { messageId: number, index: number, chatId: string, chatTitle: string, filename: string | null, mime: string, created_at: number | null };
type Row = {
  key: string, name: string, kind: FileKind, chatId: string, chatTitle: string, created_at: number | null,
  open: () => void, use: () => void, useBlocked: string
};

const session = useSession();
const chat = useChat();
const attachments = useAttachments();
const panels = usePanels();

const canDocs = computed(() => session.can(FEATURE.ATTACHMENTS));
const canImages = computed(() => session.can(FEATURE.IMAGES));
const docs = ref<DocRow[] | null>(null);
const images = ref<ImageRow[] | null>(null);
const error = ref('');
const filter = ref('');

async function load() {
  error.value = '';
  const [d, i] = await Promise.allSettled([
    canDocs.value ? api.get('/api/documents') : Promise.resolve({ documents: [] }),
    canImages.value ? api.get('/api/images') : Promise.resolve({ images: [] })
  ]);
  docs.value = d.status === 'fulfilled' ? d.value.documents : [];
  images.value = i.status === 'fulfilled' ? i.value.images : [];
  const failed = [d, i].find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed) error.value = `Could not load everything: ${failed.reason?.message || failed.reason}`;
}
const { isOpen } = usePanel(PANEL.FILES, { onOpen: load });

const imageUrl = (i: ImageRow) => `/api/images/${i.messageId}/${i.index}`;
// Images sent before names were kept go by the chat they were sent in.
const imageName = (i: ImageRow) => i.filename || i.chatTitle;

const rows = computed<Row[] | null>(() => {
  if (docs.value === null || images.value === null) return null;
  const list: Row[] = [
    ...docs.value.map((d): Row => ({
      key: `d:${d.id}`, name: d.filename, kind: fileKind(d.filename, d.mime), chatId: d.chatId, chatTitle: d.chatTitle,
      created_at: d.created_at, open: () => openDoc(d), use: () => useDoc(d), useBlocked: ''
    })),
    ...images.value.map((i): Row => ({
      key: `i:${i.messageId}:${i.index}`, name: imageName(i), kind: IMAGE_KIND, chatId: i.chatId, chatTitle: i.chatTitle,
      created_at: i.created_at, open: () => openImage(i), use: () => useImage(i),
      useBlocked: session.modelAcceptsImages ? '' : 'The current model does not take images'
    }))
  ];
  return list.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
});

const q = computed(() => filter.value.trim().toLowerCase());
const shown = computed(() => (rows.value || []).filter((r) => !q.value
  || [r.name, r.chatTitle, r.kind.label].some((t) => t.toLowerCase().includes(q.value))));

const when = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

// In the app's viewer, not a new tab.
const viewer = useViewer();
function openDoc(d: DocRow) { viewer.show([{ kind: 'document', name: d.filename, id: d.id }]); }
function openImage(i: ImageRow) { viewer.show([{ kind: 'image', name: imageName(i), src: imageUrl(i) }]); }
function goToChat(chatId: string) { if (panels.closeAll()) chat.openChat(chatId); }

// Reusing puts the file on the composer of the chat that is open, the same
// as picking it there; nothing is sent until the message is.
function useDoc(d: DocRow) {
  attachments.stageExisting(d);
  if (panels.closeAll()) chat.focusTick++;
}
async function useImage(i: ImageRow) {
  try {
    const blob = await api.blob(imageUrl(i));
    const ext = i.mime.split('/')[1] || 'png';
    const problem = attachments.stage(new File([blob], i.filename || `image.${ext}`, { type: i.mime }));
    if (problem) { error.value = problem; return; }
    if (panels.closeAll()) chat.focusTick++;
  } catch (err) {
    error.value = `Could not use that image: ${err.message}`;
  }
}
</script>

<template>
  <section id="files" :class="{ open: isOpen }" aria-label="Files">
    <div class="panel-head">
      <h2>Files</h2>
      <span v-if="rows" class="files-count">{{ rows.length }}</span>
    </div>
    <div class="files-content">
      <input v-model="filter" class="files-filter" type="search" autocomplete="off"
             placeholder="Filter by name, type or chat" aria-label="Filter files">
      <div v-if="error" class="pop-note pop-warn files-error">{{ error }}</div>

      <div v-if="rows === null" class="empty">Loading…</div>
      <div v-else-if="!shown.length" class="empty">{{ rows.length ? 'No file matches.' : 'No files yet. Attach one in a chat and it shows up here.' }}</div>
      <table v-else class="data-table files-table">
        <thead>
          <tr>
            <th>Name</th>
            <th class="files-col-type">Type</th>
            <th class="files-col-chat">Chat</th>
            <th class="files-col-date num">Added</th>
            <th class="files-col-use"><span class="visually-hidden">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in shown" :key="r.key">
            <td class="files-col-name">
              <button type="button" class="files-main" :title="`Open ${r.name}`" @click="r.open()">
                <span class="files-icon" :data-kind="r.kind.icon"><Icon :name="r.kind.icon" /></span>
                <span class="files-text">
                  <span class="files-name">{{ r.name }}</span>
                  <!-- On a phone the other columns fold into this line. -->
                  <span class="files-meta">{{ r.kind.label }} · {{ when(r.created_at) }} · {{ r.chatTitle }}</span>
                </span>
              </button>
            </td>
            <td class="files-col-type muted nowrap">{{ r.kind.label }}</td>
            <td class="files-col-chat">
              <button type="button" class="files-chat-link" :title="`Go to ${r.chatTitle}`" @click="goToChat(r.chatId)">{{ r.chatTitle }}</button>
            </td>
            <td class="files-col-date num muted">{{ when(r.created_at) }}</td>
            <td class="files-col-use">
              <button type="button" class="icon-btn files-phone-chat" :aria-label="`Go to ${r.chatTitle}`" :title="`Go to ${r.chatTitle}`"
                      @click="goToChat(r.chatId)"><Icon name="chat" size="1rem" /></button>
              <button type="button" class="primary" :disabled="!!r.useBlocked" :title="r.useBlocked || 'Put this file on the message you are writing'"
                      @click="r.use()">Use in chat</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
