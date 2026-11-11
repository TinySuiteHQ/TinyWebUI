<script setup lang="ts">
/**
 * A menu anchored to its parent (the composer's). Opens below the composer in a new chat (where it is
 * centred) and, in a conversation, below if it fits and above otherwise, with
 * its height capped to that side's room so it never hangs off the viewport
 * (an open mobile keyboard). Menus fill in after a fetch and grow when a group
 * expands, so it refits whenever its contents change, not just once.
 *
 * On a phone it is a sheet along the bottom of the screen instead: a menu
 * squeezed between the composer and an edge left its lists a few rows to
 * scroll in. A tap on the dimmed page behind it closes it, as any tap outside
 * a menu does.
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';

const props = defineProps<{ side: 'left' | 'right', centred: boolean }>();
const el = ref<HTMLElement>();
const SHEET = matchMedia('(max-width: 640px)');
const sheet = ref(SHEET.matches);
let observer: MutationObserver | undefined;

// Positioned by hand rather than through a style binding: measuring needs the
// cap lifted for a moment, which a binding would not know to put back.
function fit() {
  const pop = el.value;
  const form = pop?.parentElement;
  if (!pop || !form) return;
  const vh = window.visualViewport?.height ?? window.innerHeight;
  if (sheet.value) {
    pop.style.top = 'auto';
    pop.style.bottom = '0';
    pop.style.transformOrigin = 'bottom center';
    pop.style.maxHeight = `${Math.round(vh * 0.85)}px`;
    return;
  }
  const gap = 8;
  pop.style.maxHeight = 'none';
  const want = Math.min(pop.offsetHeight, 448);
  const rect = form.getBoundingClientRect();
  const above = rect.top - gap * 2;
  const below = vh - rect.bottom - gap * 2;
  const up = !props.centred && below < want && above > below;
  pop.style.top = up ? 'auto' : 'calc(100% + .5rem)';
  pop.style.bottom = up ? 'calc(100% + .5rem)' : 'auto';
  pop.style.transformOrigin = `${up ? 'bottom' : 'top'} ${props.side}`;
  pop.style.maxHeight = `${Math.max(64, Math.min(want, up ? above : below))}px`;
}
function onWidth() { sheet.value = SHEET.matches; fit(); }

onMounted(() => {
  fit();
  observer = new MutationObserver(fit);
  if (el.value) observer.observe(el.value, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['open'] });
  window.visualViewport?.addEventListener('resize', fit);
  SHEET.addEventListener('change', onWidth);
});
onBeforeUnmount(() => {
  observer?.disconnect();
  window.visualViewport?.removeEventListener('resize', fit);
  SHEET.removeEventListener('change', onWidth);
});
defineExpose({ el });
</script>

<template>
  <div v-if="sheet" class="sheet-backdrop" aria-hidden="true" />
  <div ref="el" class="popover" :class="[`popover-${side}`, { sheet }]" role="menu">
    <slot />
  </div>
</template>
