<script setup lang="ts">
/**
 * A menu anchored to its parent: the composer's menus, a sidebar row's, the
 * account menu. Opens below if it fits and otherwise on the side with more
 * room (`centred`: the composer in a new chat, below unless above is clearly
 * roomier), with its height capped to that side's room. The room is measured
 * against the window and every box around the anchor that clips or scrolls it
 * (the sidebar's chat list), so a menu on the last row opens upward instead of
 * vanishing under the list's edge. Menus fill in after a fetch and grow when a
 * group expands, so it refits whenever its contents change, not just once.
 *
 * On a phone it is a sheet along the bottom of the screen instead: a menu
 * squeezed between its anchor and an edge left its lists a few rows to
 * scroll in. A tap on the dimmed page behind it closes it, as any tap outside
 * a menu does. The class and attributes given to it (a label, `row-menu`) go
 * on the menu itself.
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';

defineOptions({ inheritAttrs: false });
const props = withDefaults(defineProps<{ side: 'left' | 'right', centred?: boolean }>(), { centred: false });
const el = ref<HTMLElement>();
const SHEET = matchMedia('(max-width: 640px)');
const sheet = ref(SHEET.matches);
let observer: MutationObserver | undefined;

/** The part of the window the anchor can show a menu in: inside every ancestor that clips or scrolls. */
function room(anchor: HTMLElement) {
  let top = 0, bottom = window.visualViewport?.height ?? window.innerHeight;
  for (let a = anchor.parentElement; a && a !== document.body; a = a.parentElement) {
    if (getComputedStyle(a).overflowY === 'visible') continue;
    const r = a.getBoundingClientRect();
    top = Math.max(top, r.top);
    bottom = Math.min(bottom, r.bottom);
  }
  return { top, bottom };
}

// Positioned by hand rather than through a style binding: measuring needs the
// cap lifted for a moment, which a binding would not know to put back.
function fit() {
  const pop = el.value;
  if (!pop) return;
  if (sheet.value) {
    const vh = window.visualViewport?.height ?? window.innerHeight;
    pop.style.top = 'auto';
    pop.style.bottom = '0';
    pop.style.transformOrigin = 'bottom center';
    pop.style.maxHeight = `${Math.round(vh * 0.85)}px`;
    return;
  }
  const anchor = pop.parentElement;
  if (!anchor) return;
  const gap = 8;
  pop.style.maxHeight = 'none';
  const want = Math.min(pop.offsetHeight, 448);
  const rect = anchor.getBoundingClientRect();
  const box = room(anchor);
  const above = rect.top - box.top - gap;
  const below = box.bottom - rect.bottom - gap;
  // A new chat's centred composer prefers below, but a short window (an editor's
  // preview pane) can leave less room there than above.
  const up = below < want && (props.centred ? above > below + 64 : above > below);
  pop.style.top = up ? 'auto' : 'calc(100% + var(--pop-gap, .5rem))';
  pop.style.bottom = up ? 'calc(100% + var(--pop-gap, .5rem))' : 'auto';
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
  <!-- The sheet is fixed to the screen, so it lives under body: inside main or
       the sidebar, both size containers, "fixed" would mean fixed to them. -->
  <Teleport to="body" :disabled="!sheet">
    <div v-if="sheet" class="sheet-backdrop" aria-hidden="true" />
    <div ref="el" v-bind="$attrs" class="popover" :class="[`popover-${side}`, { sheet }]" role="menu">
      <slot />
    </div>
  </Teleport>
</template>
