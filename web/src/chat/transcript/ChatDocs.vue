<script setup lang="ts">
/** Every document and image attached to the open chat, oldest first, pinned beside the transcript. */
import { computed, ref, watch } from 'vue';
import { useAttachments } from '../../stores/attachments.ts';
import { useChat } from '../../stores/chat.ts';
import Icon from '../../ui/Icon.vue';

const PREVIEW = 3;
const attachments = useAttachments();
const chat = useChat();
const expanded = ref(false);
watch(() => chat.model, () => { expanded.value = false; });

const items = computed(() => [
  ...attachments.chatDocuments.map((d) => ({ key: `d:${d.id}`, kind: 'doc' as const, name: d.filename, title: `${d.filename} · ${d.char_len.toLocaleString('en-US')} chars`, id: d.id, img: null })),
  ...attachments.chatImages.map((img, i) => ({ key: `i:${i}`, kind: 'image' as const, name: img.filename || 'image', title: img.filename || 'attached image', id: '', img }))
]);
const shown = computed(() => (expanded.value ? items.value : items.value.slice(0, PREVIEW)));

function open(a: (typeof items.value)[number]) {
  // A document opens as uploaded (a PDF in the viewer, a .docx downloads); an image full size.
  if (a.kind === 'doc') window.open(`/api/documents/${a.id}/original`, '_blank', 'noopener');
  else if (a.img) window.open(`data:${a.img.mime};base64,${a.img.data}`, '_blank');
}
</script>

<template>
  <aside class="right-rail">
    <div v-if="items.length" id="chatDocs" class="rail-card">
      <span class="label">Artifacts</span>
      <button v-for="a in shown" :key="a.key" type="button" class="rail-item" :title="a.title" @click="open(a)">
        <span class="icon"><Icon :name="a.kind" /></span><span class="text">{{ a.name }}</span>
      </button>
      <button v-if="items.length > PREVIEW" type="button" class="rail-more" @click="expanded = !expanded">
        {{ expanded ? 'show less' : `+${items.length - PREVIEW} more` }}
      </button>
    </div>
  </aside>
</template>
