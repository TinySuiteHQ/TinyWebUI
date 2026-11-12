<script setup lang="ts">
/**
 * The page's icons, in the TinySuite marks' own language rather than a stock
 * outline set: a thing is one solid soft shape with its detail cut out of it,
 * the way each product mark is a solid bunny with its symbol cut out (the chat
 * icon is the TinyWebUI bubble, a page is the TinyContext window). Only pure
 * gestures (arrows, chevrons, plus, check) are lines, and those are as heavy
 * as the marks' strokes. Each icon is lists of SVG shapes built by Vue, never
 * HTML strings. The TinySearch and TinyContext marks are their own files in
 * public/icons.
 */
import { computed, useId } from 'vue';

type Shape = { tag: 'path' | 'circle' | 'rect', attrs: Record<string, string | number> };
/** solid: filled, with `cut` knocked out of it; line: stroked on top. */
type Glyph = { solid?: Shape[], cut?: Shape[], line?: Shape[] };

const p = (d: string): Shape => ({ tag: 'path', attrs: { d } });
const circle = (cx: number, cy: number, r: number): Shape => ({ tag: 'circle', attrs: { cx, cy, r } });
const rect = (x: number, y: number, width: number, height: number, rx: number): Shape => ({ tag: 'rect', attrs: { x, y, width, height, rx } });
/** A cut that is a filled hole rather than a stroke, inside `cut`. */
const hole = (s: Shape): Shape => ({ ...s, attrs: { ...s.attrs, fill: '#000', stroke: 'none' } });
/** A filled shape inside `line`. */
const fill = (s: Shape): Shape => ({ ...s, attrs: { ...s.attrs, fill: 'currentColor', stroke: 'none' } });

// The chat bubble of the TinyWebUI mark: a soft box, its tail low on the left.
const BUBBLE = p('M7.5 3.5h9a4.5 4.5 0 0 1 4.5 4.5v5.5a4.5 4.5 0 0 1-4.5 4.5H10l-4.2 3.2a.8.8 0 0 1-1.3-.64V17.6A4.5 4.5 0 0 1 3 13.5V8a4.5 4.5 0 0 1 4.5-4.5Z');
// A page: the context window's soft frame, upright.
const PAGE = rect(4.5, 2.5, 15, 19, 4);
const FOLDER = p('M2.5 7.5a3 3 0 0 1 3-3h3.4a2 2 0 0 1 1.4.6l1.4 1.4h6.8a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3h-13a3 3 0 0 1-3-3Z');
const PERSON = [circle(12, 7.5, 4), p('M4 19.5a8 6.5 0 0 1 16 0 1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19.5Z')];
const HANDS = p('M12 8.5V12l2.5 1.75');
const PIN = p('M8.5 3h7a1.25 1.25 0 0 1 1 2l-1.5 2v3.5l3.1 2.6a1.25 1.25 0 0 1-.8 2.2H6.7a1.25 1.25 0 0 1-.8-2.2L9 10.5V7L7.5 5a1.25 1.25 0 0 1 1-2Z');

const ICONS: Record<string, Glyph> = {
  // Sidebar and navigation
  new: { solid: [BUBBLE], cut: [p('M12 7.25v6.5M8.75 10.5h6.5')] },
  chat: { solid: [BUBBLE], cut: [hole(circle(8.25, 10.75, 1.4)), hole(circle(12, 10.75, 1.4)), hole(circle(15.75, 10.75, 1.4))] },
  search: { solid: [circle(10.5, 10.5, 7.5)], cut: [hole(circle(10.5, 10.5, 4.25))], line: [{ tag: 'path', attrs: { d: 'm16.25 16.25 4.25 4.25', 'stroke-width': 3.25 } }] },
  files: { solid: [rect(3.5, 7, 12.5, 14.5, 3.5)], cut: [p('M7 12h5.5M7 15.75h3.5')], line: [p('M8.5 3.25h7.25a3.5 3.5 0 0 1 3.5 3.5V15')] },
  mcp: { solid: [p('M5.5 8h13v3.5a6.5 6.5 0 0 1-13 0Z')], line: [p('M9 3v3.5M15 3v3.5M12 18v3')] },
  automations: { solid: [circle(12, 13, 7.75)], cut: [p('M12 9.5V13l2.5 1.75')], line: [p('M3.5 6.5l3-3M20.5 6.5l-3-3')] },
  folderPlus: { solid: [FOLDER], cut: [p('M12 10.25v5.5M9.25 13h5.5')] },
  folder: { solid: [FOLDER] },
  // The same folder with its front tipped forward, a gap between back and front.
  folderOpen: {
    solid: [
      p('M2.5 7.5a3 3 0 0 1 3-3h3.4a2 2 0 0 1 1.4.6l1.4 1.4h5.8a3 3 0 0 1 3 3v.5H8.4a3 3 0 0 0-2.75 1.8L2.5 17.2Z'),
      p('M8.4 11.25H21a1.3 1.3 0 0 1 1.25 1.65l-1.7 5.7a2.7 2.7 0 0 1-2.6 1.9H4.3a1.3 1.3 0 0 1-1.2-1.8l2.6-5.85a2.5 2.5 0 0 1 2.7-1.6Z')
    ]
  },
  sidebar: { solid: [p('M7.5 4h2.5v16H7.5A4.5 4.5 0 0 1 3 15.5v-7A4.5 4.5 0 0 1 7.5 4Z')], line: [rect(4, 4.5, 16, 15, 4)] },
  logout: { line: [p('M10 4H7.5A3.5 3.5 0 0 0 4 7.5v9A3.5 3.5 0 0 0 7.5 20H10'), p('m15 7.5 4.5 4.5-4.5 4.5M19.5 12H9.5')] },
  more: { solid: [circle(5.5, 12, 2), circle(12, 12, 2), circle(18.5, 12, 2)] },
  // A push pin: a solid head on a short needle; unpin crosses it out.
  pin: { solid: [PIN], line: [p('M12 15.5V21')] },
  unpin: { solid: [PIN], cut: [p('M3.5 3.5l17 17')], line: [p('M12 15.5V21'), p('M3.5 3.5l17 17')] },
  instructions: { solid: [rect(3.5, 5, 17, 3, 1.5), rect(3.5, 10.5, 17, 3, 1.5), rect(3.5, 16, 10, 3, 1.5)] },

  // Settings rail
  settings: { line: [p('M3.5 7.5h17M3.5 16.5h17'), fill(circle(14.5, 7.5, 3)), fill(circle(8.5, 16.5, 3))] },
  account: { solid: PERSON },
  appearance: { solid: [p('M12 3a9 9 0 0 1 0 18Z')], line: [circle(12, 12, 8)] },
  statistics: { solid: [rect(3.5, 12.5, 4.5, 8, 2), rect(9.75, 4, 4.5, 16.5, 2), rect(16, 9, 4.5, 11.5, 2)] },
  data: { solid: [p('M3 14.5h4l1.5 2h7l1.5-2h4v3a3.5 3.5 0 0 1-3.5 3.5h-11A3.5 3.5 0 0 1 3 17.5Z')], line: [p('M12 3.5v8.5'), p('m8.25 8.75 3.75 3.75 3.75-3.75')] },
  models: { solid: [rect(5.5, 5.5, 13, 13, 3.5)], cut: [hole(rect(9.25, 9.25, 5.5, 5.5, 1.25))], line: [p('M9.5 2.5v2M14.5 2.5v2M9.5 19.5v2M14.5 19.5v2M2.5 9.5h2M2.5 14.5h2M19.5 9.5h2M19.5 14.5h2')] },
  defaults: { solid: [p('M3 17a9 9 0 0 1 18 0 1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17Z')], cut: [p('m12 15.5 3.5-4.5'), hole(circle(12, 15.5, 1.75))] },
  admin: { solid: [circle(9.5, 8, 3.75), p('M2.5 19.5a7 6 0 0 1 14 0 1.5 1.5 0 0 1-1.5 1.5H4a1.5 1.5 0 0 1-1.5-1.5Z')], line: [p('M15.5 4.6a3.5 3.5 0 0 1 0 6.8M18.5 13.6a7 6 0 0 1 3 5.4')] },

  // Composer
  send: { line: [p('M12 19.5v-14'), p('m6 11 6-6 6 6')] },
  stop: { solid: [rect(6.5, 6.5, 11, 11, 3)] },
  plus: { line: [p('M12 4.5v15M4.5 12h15')] },
  paperclip: { line: [p('M20 11.5 12.4 19a5 5 0 0 1-7.1-7.1l8-8a3.4 3.4 0 0 1 4.8 4.8l-8 8a1.7 1.7 0 0 1-2.4-2.4L15 7')] },
  camera: { solid: [p('M2.5 9a3.5 3.5 0 0 1 3.5-3.5h1.5l1.3-1.7a2 2 0 0 1 1.6-.8h3.2a2 2 0 0 1 1.6.8l1.3 1.7H18A3.5 3.5 0 0 1 21.5 9v7.5A3.5 3.5 0 0 1 18 20H6a3.5 3.5 0 0 1-3.5-3.5Z')], cut: [hole(circle(12, 12.5, 4)), ], line: [fill(circle(12, 12.5, 1.75))] },
  history: { line: [p('M4.5 12A7.5 7.5 0 1 0 6.7 6.7L4.5 9'), p('M4.5 4.5V9H9'), HANDS] },
  clock: { solid: [circle(12, 12, 9)], cut: [p('M12 7.5V12l3 2')] },

  // Files, by kind: the page, with what is on it cut out
  doc: { solid: [PAGE], cut: [p('M8.5 8h7M8.5 12h7M8.5 16h4')] },
  filePdf: { solid: [PAGE], cut: [p('M8.5 8h7M8.5 11.5h4'), hole(rect(8, 14.5, 8, 3.75, 1.25))] },
  fileSheet: { solid: [PAGE], cut: [p('M4.5 9.5h15M4.5 15h15M12 9.5v12')] },
  fileCode: { solid: [PAGE], cut: [p('m10 9-2.5 3L10 15M14 9l2.5 3L14 15')] },
  image: { solid: [rect(2.5, 4, 19, 16, 4.5)], cut: [hole(circle(8.5, 9.5, 2)), hole(p('M2.5 18.5 9 12l4 4 2.5-2.5 6 6v1h-19Z'))] },

  // Transcript and actions
  steps: { line: [fill(circle(5, 6.5, 2)), fill(circle(5, 12, 2)), fill(circle(5, 17.5, 2)), p('M10 6.5h10M10 12h10M10 17.5h6.5')] },
  edit: { solid: [p('M4.6 20.9a1 1 0 0 1-1.2-1.2l.9-4.2a2 2 0 0 1 .55-1L15.2 4.2a2.8 2.8 0 0 1 4 0l.6.6a2.8 2.8 0 0 1 0 4L9.5 19.1a2 2 0 0 1-1 .55Z')], cut: [p('m13.5 6.5 4 4')] },
  retry: { line: [p('M19.5 12A7.5 7.5 0 1 1 17.3 6.7L19.5 9'), p('M19.5 4.5V9H15')] },
  copy: { solid: [rect(8, 8, 13, 13, 3.5)], line: [p('M15.5 4.75A2.5 2.5 0 0 0 13 3.25H6A2.75 2.75 0 0 0 3.25 6v7A2.5 2.5 0 0 0 4.75 15.5')] },
  fork: { line: [fill(circle(6.5, 5, 2.5)), fill(circle(6.5, 19, 2.5)), fill(circle(17.5, 7, 2.5)), p('M6.5 7.5v9'), p('M17.5 9.5a5.5 5.5 0 0 1-5.5 5.5H6.5')] },
  trash: { solid: [p('M5 8h14l-.95 11a2.5 2.5 0 0 1-2.5 2.3h-7.1a2.5 2.5 0 0 1-2.5-2.3Z')], cut: [p('M10 11.5v6M14 11.5v6')], line: [p('M3.5 5h17M9.5 5V3.5h5V5')] },
  check: { line: [p('m4.5 12.5 5 5 10-11')] },
  x: { line: [p('M6 6l12 12M18 6 6 18')] },
  chevronDown: { line: [p('m6 9.5 6 6 6-6')] },
  chevronRight: { line: [p('m9.5 6 6 6-6 6')] },
  chevronLeft: { line: [p('m14.5 6-6 6 6 6')] },
  arrowDown: { line: [p('M12 4.5v15'), p('m6 13.5 6 6 6-6')] },
  arrowLeft: { line: [p('M19.5 12h-15'), p('m10.5 6-6 6 6 6')] },
  arrowRight: { line: [p('M4.5 12h15'), p('m13.5 6 6 6-6 6')] },
  // A task's state: to do, under way, done.
  todo: { line: [circle(12, 12, 7)] },
  doing: { solid: [p('M12 5a7 7 0 0 1 0 14Z')], line: [circle(12, 12, 7)] }
};

const props = defineProps<{ name: keyof typeof ICONS | string, size?: string }>();
const glyph = computed<Glyph>(() => ICONS[props.name] || {});
// Each drawn icon needs its own mask id: the same icon appears many times on a page.
const maskId = `ic-${useId()}`;
</script>

<template>
  <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round"
       stroke-linejoin="round" aria-hidden="true" :style="size ? { width: size, height: size } : undefined">
    <mask v-if="glyph.cut" :id="maskId" maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
      <rect width="24" height="24" fill="#fff" stroke="none" />
      <g fill="none" stroke="#000" stroke-width="2.25">
        <component :is="s.tag" v-for="(s, i) in glyph.cut" :key="i" v-bind="s.attrs" />
      </g>
    </mask>
    <g v-if="glyph.solid" fill="currentColor" stroke="none" :mask="glyph.cut ? `url(#${maskId})` : undefined">
      <component :is="s.tag" v-for="(s, i) in glyph.solid" :key="i" v-bind="s.attrs" />
    </g>
    <component :is="s.tag" v-for="(s, i) in glyph.line || []" :key="`l${i}`" v-bind="s.attrs" />
  </svg>
</template>
