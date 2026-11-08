<script setup lang="ts">
/**
 * The page's line icons, one stroke style. Each is a list of SVG shapes so the
 * markup stays declarative, built by Vue rather than from HTML strings.
 */
type Shape = { tag: 'path' | 'circle' | 'rect', attrs: Record<string, string | number> };
const p = (d: string): Shape => ({ tag: 'path', attrs: { d } });
const circle = (cx: number, cy: number, r: number): Shape => ({ tag: 'circle', attrs: { cx, cy, r } });
const rect = (x: number, y: number, width: number, height: number, rx: number, fill?: string): Shape =>
  ({ tag: 'rect', attrs: { x, y, width, height, rx, ...(fill ? { fill } : {}) } });

const ICONS: Record<string, Shape[]> = {
  new: [p('M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7'), p('M18.4 2.6a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4Z')],
  search: [circle(11, 11, 8), p('m21 21-4.3-4.3')],
  automations: [p('M12 9v4l2.5 1.5'), p('M19 3.5 21.5 6'), p('M5 3.5 2.5 6'), circle(12, 13, 8)],
  integrations: [rect(3, 3, 7, 7, 1.5), rect(14, 3, 7, 7, 1.5), rect(3, 14, 7, 7, 1.5), p('M17.5 14v7'), p('M14 17.5h7')],
  mcp: [p('M12 22v-5'), p('M9 8V2'), p('M15 8V2'), p('M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z')],
  settings: [p('M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z'), circle(12, 12, 3)],
  statistics: [p('M3 3v16a2 2 0 0 0 2 2h16'), p('M18 17V9'), p('M13 17V5'), p('M8 17v-3')],
  admin: [p('M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2'), circle(9, 7, 4), p('M22 21v-2a4 4 0 0 0-3-3.87'), p('M16 3.13a4 4 0 0 1 0 7.75')],
  logout: [p('M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4'), p('m16 17 5-5-5-5'), p('M21 12H9')],
  folderPlus: [p('M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z'), p('M12 11v4M10 13h4')],
  sidebar: [rect(3, 4, 18, 16, 2), p('M9 4v16')],
  send: [p('M12 19V5M5 12l7-7 7 7')],
  stop: [rect(7, 7, 10, 10, 1.5, 'currentColor')],
  plus: [p('M12 5v14M5 12h14')],
  paperclip: [p('M21 11.5 12.5 20a5.5 5.5 0 0 1-7.8-7.8l8.9-8.9a3.7 3.7 0 0 1 5.2 5.2l-8.9 8.9a1.8 1.8 0 0 1-2.6-2.6L15.5 7')],
  history: [p('M3 12a9 9 0 1 0 3-6.7L3 8'), p('M3 3v5h5'), p('M12 7v5l3 2')],
  chevronDown: [p('m6 9 6 6 6-6')],
  chevronRight: [p('m9 6 6 6-6 6')],
  clock: [circle(12, 12, 9), p('M12 7v5l3 2')],
  doc: [p('M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z'), p('M14 3v5h5'), p('M9 13h6M9 17h4')],
  image: [rect(3, 4, 18, 16, 2), circle(9, 10, 2), p('m21 17-5-5-9 8')],
  files: [p('M15 2H8a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7Z'), p('M15 2v5h5'), p('M4 7v13a2 2 0 0 0 2 2h10')],
  camera: [p('M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3Z'), circle(12, 13, 3.5)],
  arrowDown: [p('M12 5v14M5 12l7 7 7-7')],
  check: [p('M5 12.5 10 17 19 7')],
  x: [p('M6 6l12 12M18 6 6 18')],
  edit: [p('M12 20h9'), p('M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z')],
  retry: [p('M21 12a9 9 0 1 1-3-6.7L21 8'), p('M21 3v5h-5')],
  copy: [rect(9, 9, 12, 12, 2), p('M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1')],
  sparkle: [p('M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8Z')],
  more: [circle(5, 12, 1), circle(12, 12, 1), circle(19, 12, 1)]
};

defineProps<{ name: keyof typeof ICONS | string, size?: string }>();
</script>

<template>
  <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
       stroke-linejoin="round" aria-hidden="true" :style="size ? { width: size, height: size } : undefined">
    <component :is="s.tag" v-for="(s, i) in ICONS[name] || []" :key="i" v-bind="s.attrs" />
  </svg>
</template>
