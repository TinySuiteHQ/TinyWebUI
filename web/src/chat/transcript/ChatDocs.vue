<script setup lang="ts">
/** Every document and image attached to the open chat, oldest first, pinned beside the transcript. */
import { computed, ref, watch } from 'vue';
import { useAttachments } from '../../stores/attachments.ts';
import { useChat } from '../../stores/chat.ts';
import { useViewer, type ViewItem } from '../../stores/viewer.ts';
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

const viewer = useViewer();
// Opened in the app's viewer, with every other artifact of the chat a step away.
function open(a: (typeof items.value)[number]) {
  const list: ViewItem[] = items.value.map((x) => (x.kind === 'doc'
    ? { kind: 'document', name: x.name, id: x.id }
    : { kind: 'image', name: x.name, src: `data:${x.img!.mime};base64,${x.img!.data}` }));
  viewer.show(list, items.value.indexOf(a));
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
