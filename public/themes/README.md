# Themes

A theme is a folder drop, not a patch. Nothing in `app.js` or `styles.css`
knows any theme exists, and adding one never changes either file.

```
public/themes/
  manifest.json     the list. one line per theme
  theme-loader.js   the only bridge to the app
  scene-kit.js      the runtime a moving theme is built on
  fall-fairy.css    a theme
  fall-fairy.js     ...and its scenery
```

## The smallest theme

Drop a CSS file in here and add a line to `manifest.json`:

```json
{ "id": "dusk", "name": "Dusk", "file": "dusk.css" }
```

The file reassigns the variables `styles.css` already reads. That is the whole
API:

```css
:root[data-theme="dusk"] {
  --bg: #12131a; --panel: #1a1c26; --line: #2e3142; --fg: #e9eaf2;
  --muted: #a3a7bd; --faint: #878ba4; --accent: #7c6cff; --tool: #4fd6b8; --err: #ff8093;
  --mono: "Space Mono", ui-monospace, monospace;
}
```

Anything past that is yours, on one condition: **scope every rule under
`[data-theme="<id>"]`.** A theme that leaks outside its own attribute is a
fork of the stylesheet wearing a theme's clothes.

The picker in settings → appearance is built from the manifest, and the choice
is remembered in `localStorage`. Removing a theme's files is a complete
uninstall.

## A theme that moves

Name a module and it is mounted while your theme is selected, unmounted when it
is not:

```json
{ "id": "dusk", "name": "Dusk", "file": "dusk.css", "js": "dusk.js" }
```

```js
export function mount() {
  // ...
  return () => { /* leave no trace */ };
}
```

`mount()` returns its own teardown. If the module throws or fails to load, the
loader swallows it and your theme is still a theme — the CSS half always stands
on its own.

## scene-kit

Don't write that module by hand. Every moving theme needs the same six
unglamorous parts — canvases at the right depth, a device-pixel-correct resize,
a frame loop that pauses itself when the tab is hidden, the reduced-motion
path, the app's current state, and a teardown that leaves nothing behind.
`scene-kit.js` is those parts, so your theme is only ever its own artwork.

```js
import { createScene } from './scene-kit.js';

export function mount() {
  let dots = [];
  return createScene({
    layers: [{ name: 'bg', z: -1 }, { name: 'fg', z: 5 }],
    vars:      { glow: '--dusk-glow', ink: ['--dusk-a', '--dusk-b'] },
    fallbacks: { glow: '#ffd98a',     ink: ['#7c6cff', '#4fd6b8'] },

    setup(ctx)      { dots = seed(ctx.w, ctx.h); },   // mount, resize, palette change
    update(ctx, dt) { for (const d of dots) d.y += d.v * dt; },
    draw(ctx)       { ctx.clear('fg'); /* ... */ },
  });
}
```

`createScene` returns the unmount function, so `return createScene({...})` is
the whole of `mount()`.

### What `ctx` gives you

| | |
|---|---|
| `ctx.w` `ctx.h` | viewport, in CSS pixels |
| `ctx.t` `ctx.dt` | seconds since mount, seconds this frame |
| `ctx.layer(name)` | that layer's 2d context, already DPR-scaled |
| `ctx.clear(name)` | clear a layer |
| `ctx.pal` | your `vars`, resolved against the live palette |
| `fallbacks` | a value per `vars` key, used when a property reads back empty |
| `ctx.mode` | `empty` · `idle` · `busy` · `done` |
| `ctx.modeAge` | seconds in the current mode |
| `ctx.pointer` | `{ x, y, inside, vx, vy, speed, downFor }` |
| `ctx.anchor(what)` | `transcript` · `scroller` · `composer` · `viewport` → DOMRect\|null |
| `ctx.words(n)` | up to n perchable word handles in the transcript |
| `ctx.reduced` | true when the viewer asked for less motion |
| `ctx.on(evt, fn)` | `mode` · `pointerdown` · `resize` |

### The modes

All four are read from markup the app already produces for its own reasons. No
hook was added anywhere for a theme to read, and a theme never queries the app
itself — that coupling lives in `scene-kit.js`, once, for every theme at once.

| mode | what the app is doing | where it comes from |
|---|---|---|
| `empty` | a fresh chat, nothing asked yet | `#wrap` has no children |
| `busy` | a turn is running | `#send` carries `.stop` |
| `done` | an answer just landed (transient, ~2.4s) | `.stop` came off |
| `idle` | a transcript, sitting there | anything else |

### Words

`ctx.words(n)` returns handles onto real text in the transcript. Each keeps a
live `Range`, so ask for the box when you need it rather than caching it:

```js
const w = pick(ctx.words(60));
const r = w.rect();     // DOMRect, or null if edited away or scrolled out
```

Because the box is read back per frame, anything you park on a word rides it as
the transcript scrolls, and lets go by itself when the word is re-rendered. The
harvest is the expensive half, so it is sampled, capped, cached for a beat, and
thrown away whenever the transcript changes or scrolls.

## House rules

These are not the loader's to enforce. They are what keeps a theme a theme.

- **Decorative only.** Layers are `pointer-events: none`. Nothing a theme draws
  may be the only way to see or do something.
- **Read, never write.** A theme reads state; it never dispatches an event,
  sets a class on app markup, or touches the transcript.
- **Stay under the app's ceiling.** Settings sits at `z-index: 10`, the mobile
  drawer at `19`/`20`. A foreground layer above those covers the UI.
- **Text first.** If your scene sits behind the transcript, put a scrim on the
  reading surfaces. `fall-fairy.css` does this with `color-mix` and a blur; the
  forest is never allowed behind a raw paragraph.
- **Honour `prefers-reduced-motion`.** The kit already does — it draws one still
  frame and keeps the observers running, so state still changes without
  animating. Don't defeat it.
- **Offline is the default.** TinyWebUI runs on a laptop with no network. A
  theme reaching for a CDN needs a fallback that is genuinely fine
  (`fall-fairy.css` ships full local font stacks behind its `@import`).
- **Clean up.** Whatever `mount()` added, its teardown removes. The kit handles
  this for everything it created; anything you add yourself is yours to undo.

## fall-fairy

The worked example, and the stress test for all of the above: a procedural
autumn forest on two canvases, a flock with flight behaviour, cursor reactions,
and fairies that land on the words of your transcript and read them.

- `empty` — she waits in the clearing, on a pumpkin, chin on hand
- `busy` — the flock goes out with lanterns, quartering the window
- `done` — they come home to the answer and light it up
- the cursor — a still one gets orbited, a fast one scatters them, and moving
  through falling leaves shoves them aside
- perching — a fairy picks a word, stands on it, dusts it with light, and rides
  it while you scroll

It also re-voices the app: Grandstander for headings, Quicksand for everything
you read, Space Mono for the machine's own voice, and Caveat for the one
handwritten line in the clearing.
