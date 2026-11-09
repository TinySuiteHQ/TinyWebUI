<script setup lang="ts">
/**
 * Files: everything the person has attached, across every chat. Documents and
 * images are separate tabs because they are separate things: a document is
 * stored once with its text and can be put into another chat as is; an image
 * lives on the message that sent it, so reusing one stages its bytes again.
 * Read fresh on every open; nothing else reads this, so it stays local.
 */
import { computed, ref } from 'vue';
import { api } from '../../core/api.ts';
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
type Tab = 'documents' | 'images';

const session = useSession();
const chat = useChat();
const attachments = useAttachments();
const panels = usePanels();

const canDocs = computed(() => session.can(FEATURE.ATTACHMENTS));
const canImages = computed(() => session.can(FEATURE.IMAGES));
const tab = ref<Tab>('documents');
const docs = ref<DocRow[] | null>(null);
const images = ref<ImageRow[] | null>(null);
const error = ref('');
const filter = ref('');
let opened = false;

async function load() {
  error.value = '';
  if (!canDocs.value) tab.value = 'images';
  const [d, i] = await Promise.allSettled([
    canDocs.value ? api.get('/api/documents') : Promise.resolve({ documents: [] }),
    canImages.value ? api.get('/api/images') : Promise.resolve({ images: [] })
  ]);
  const docList: DocRow[] = d.status === 'fulfilled' ? d.value.documents : [];
  const imageList: ImageRow[] = i.status === 'fulfilled' ? i.value.images : [];
  docs.value = docList;
  images.value = imageList;
  // Land on the kind there is something of, the first time it opens.
  if (!opened && !docList.length && imageList.length && canImages.value) tab.value = 'images';
  opened = true;
  const failed = [d, i].find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed) error.value = `Could not load everything: ${failed.reason?.message || failed.reason}`;
}
const { isOpen } = usePanel(PANEL.FILES, { onOpen: load });

const q = computed(() => filter.value.trim().toLowerCase());
const matches = (...texts: (string | null)[]) => !q.value || texts.some((t) => t?.toLowerCase().includes(q.value));
const shownDocs = computed(() => (docs.value || []).filter((d) => matches(d.filename, d.chatTitle)));
const shownImages = computed(() => (images.value || []).filter((i) => matches(i.filename, i.chatTitle)));

const extOf = (name: string) => (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toUpperCase() : 'FILE');
const when = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const imageUrl = (i: ImageRow) => `/api/images/${i.messageId}/${i.index}`;
// Images sent before names were kept go by the chat they were sent in.
const imageName = (i: ImageRow) => i.filename || i.chatTitle;

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
      <div v-if="canDocs && canImages" class="files-tabs" role="tablist" aria-label="Kind of file">
        <button type="button" role="tab" :aria-selected="tab === 'documents'" :class="{ active: tab === 'documents' }" @click="tab = 'documents'">
          Documents<span v-if="docs" class="files-count">{{ docs.length }}</span>
        </button>
        <button type="button" role="tab" :aria-selected="tab === 'images'" :class="{ active: tab === 'images' }" @click="tab = 'images'">
          Images<span v-if="images" class="files-count">{{ images.length }}</span>
        </button>
      </div>
    </div>
    <div class="files-content">
      <input v-model="filter" class="files-filter" type="search" autocomplete="off"
             :placeholder="tab === 'documents' ? 'Filter by file or chat name' : 'Filter by image or chat name'" aria-label="Filter files">
      <div v-if="error" class="pop-note pop-warn files-error">{{ error }}</div>

      <template v-if="tab === 'documents'">
        <div v-if="docs === null" class="empty">Loading…</div>
        <div v-else-if="!shownDocs.length" class="empty">{{ docs.length ? 'No document matches.' : 'No documents yet. Attach one in a chat and it shows up here.' }}</div>
        <ul v-else class="files-list">
          <li v-for="d in shownDocs" :key="d.id" class="files-row">
            <button type="button" class="files-main" :title="`Open ${d.filename}`" @click="openDoc(d)">
              <span class="files-icon"><Icon name="doc" /></span>
              <span class="files-text">
                <span class="files-name">{{ d.filename }}</span>
                <span class="files-meta">{{ extOf(d.filename) }} · {{ when(d.created_at) }} · {{ d.chatTitle }}</span>
              </span>
            </button>
            <span class="files-actions">
              <button type="button" @click="goToChat(d.chatId)">Go to chat</button>
              <button type="button" class="primary" @click="useDoc(d)">Use in chat</button>
            </span>
          </li>
        </ul>
      </template>

      <template v-else>
        <div v-if="images === null" class="empty">Loading…</div>
        <div v-else-if="!shownImages.length" class="empty">{{ images.length ? 'No image matches.' : 'No images yet. Attach one in a chat and it shows up here.' }}</div>
        <ul v-else class="files-grid">
          <li v-for="i in shownImages" :key="`${i.messageId}:${i.index}`" class="files-tile">
            <button type="button" class="files-thumb" :title="`Open ${imageName(i)}`" @click="openImage(i)">
              <img :src="imageUrl(i)" :alt="imageName(i)" loading="lazy">
            </button>
            <span class="files-name" :title="imageName(i)">{{ imageName(i) }}</span>
            <span class="files-meta" :title="i.chatTitle">{{ when(i.created_at) }}{{ i.filename ? ` · ${i.chatTitle}` : '' }}</span>
            <span class="files-actions">
              <button type="button" @click="goToChat(i.chatId)">Chat</button>
              <button type="button" class="primary" :disabled="!session.modelAcceptsImages"
                      :title="session.modelAcceptsImages ? '' : 'The current model does not take images'" @click="useImage(i)">Use</button>
            </span>
          </li>
        </ul>
      </template>
    </div>
  </section>
</template>
