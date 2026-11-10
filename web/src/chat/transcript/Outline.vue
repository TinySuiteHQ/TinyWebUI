<script setup lang="ts">
/**
 * The conversation minimap: one flat tick per question on the right edge. At
 * rest it is just marks; hovering or focusing one shows its question, and a
 * click jumps the transcript there.
 */
import { computed } from 'vue';
import { useChat } from '../../stores/chat.ts';

const chat = useChat();
const questions = computed(() => chat.model.items.flatMap((i) => (i.kind === 'user'
  ? [{ id: i.id, text: (i.text || '(attached document)').replace(/\s+/g, ' ').trim() }] : [])));
function jump(id: string) {
  const el = document.querySelector(`[data-item="${id}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  // Turns not drawn yet count at an estimated height (content-visibility in
  // chat.css), so a long jump can land a little off: settle on the real spot
  // once the scroll stops and they have been drawn.
  document.getElementById('log')?.addEventListener('scrollend', () => el.scrollIntoView({ block: 'start' }), { once: true });
}
</script>

<template>
  <aside v-if="questions.length > 1" id="chatOutline" class="outline-rail">
    <button v-for="q in questions" :key="q.id" type="button" class="outline-tick" :aria-label="q.text" @click="jump(q.id)">
      <span class="tip">{{ q.text }}</span><span class="bar" />
    </button>
  </aside>
</template>
