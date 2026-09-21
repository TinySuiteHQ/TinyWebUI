/* ============================================================================
   scene-kit — the runtime behind a scenery skin.

   A skin that only recolours things needs nothing but CSS. A skin that wants
   to put something moving on the page needs the same six unglamorous parts
   every time: canvases at the right depth, a device-pixel-correct resize, a
   frame loop that pauses itself, the reduced-motion path, the app's current
   state, and a teardown that leaves no trace. This module is those parts, so a
   skin is only ever its own artwork.

   It is also the single place that knows TinyWebUI's markup. A skin never
   queries the app: it reads ctx.mode, ctx.anchor() and ctx.words(), and if the
   app's DOM changes one day, it changes here, once, for every skin at once.

   Contract, in full:

     import { createScene } from './scene-kit.js';

     export function mount() {
       return createScene({
         layers: [{ name: 'bg', z: -1 }, { name: 'fg', z: 5 }],
         vars:   { glow: '--my-glow' },          // read from CSS custom props
         setup(ctx) { },                          // mount, resize, theme change
         update(ctx, dt) { },                     // once per frame
         draw(ctx) { },                           // once per frame, after update
       });
     }

   createScene returns the unmount function the loader expects.

   What ctx carries:
     ctx.w, ctx.h        viewport, in css pixels
     ctx.t, ctx.dt       seconds since mount, seconds this frame
     ctx.layer(name)     that layer's 2d context, already dpr-scaled
     ctx.clear(name)     clear a layer
     ctx.pal             `vars` resolved against the current palette
     ctx.mode            'empty' | 'idle' | 'busy' | 'done'
     ctx.modeAge         seconds in the current mode
     ctx.pointer         { x, y, inside, vx, vy, speed, downFor }
     ctx.anchor(what)    'transcript' | 'composer' | 'viewport' -> DOMRect|null
     ctx.words(n)        up to n perchable word handles in the transcript
     ctx.reduced         true when the viewer asked for less motion
     ctx.on(evt, fn)     'mode' | 'pointerdown' | 'resize'

   The modes, and where they come from — all of it markup the app already
   produces for its own reasons, none of it a hook added for a skin:

     empty   #wrap has no children      a fresh chat, nothing asked yet
     busy    #send carries .stop        a turn is running
     done    .stop just came off        transient, ~2.4s, then idle
     idle    anything else              a transcript, sitting there
   ========================================================================== */

const DONE_FOR = 2.4;

export function createScene(spec) {
  const {
    layers = [{ name: 'fg', z: 5 }],
    vars = {},
    fallbacks = {},
    setup = () => {},
    update = () => {},
    draw = () => {},
  } = spec;

  const reducedQ = matchMedia('(prefers-reduced-motion: reduce)');
  const darkQ = matchMedia('(prefers-color-scheme: dark)');

  const canvases = new Map();
  for (const l of layers) {
    const c = document.createElement('canvas');
    c.className = 'scene-layer';
    c.dataset.layer = l.name;
    c.setAttribute('aria-hidden', 'true');
    // Inline, so a skin needs no CSS at all to get its layers placed right,
    // and so the app's own stacking (settings 10, drawer 19/20) is respected
    // by default rather than by each skin remembering to.
    c.style.cssText =
      `position:fixed;inset:0;width:100%;height:100%;pointer-events:none;` +
      `user-select:none;z-index:${l.z ?? 0}`;
    document.body.appendChild(c);
    canvases.set(l.name, { el: c, ctx: c.getContext('2d') });
  }

  const listeners = { mode: [], pointerdown: [], resize: [] };
  const emit = (evt, arg) => {
    for (const fn of listeners[evt] || []) {
      try { fn(ctx, arg); } catch { /* one bad handler must not kill the loop */ }
    }
  };

  const pointer = { x: -1e4, y: -1e4, inside: false, vx: 0, vy: 0, speed: 0, downFor: 0 };

  const ctx = {
    w: 0, h: 0, t: 0, dt: 0,
    pal: {},
    mode: 'idle',
    modeAge: 0,
    pointer,
    reduced: reducedQ.matches,
    layer: (name) => canvases.get(name)?.ctx,
    clear(name) {
      const c = canvases.get(name);
      if (c) c.ctx.clearRect(0, 0, this.w, this.h);
    },
    anchor,
    words,
    on(evt, fn) { (listeners[evt] ||= []).push(fn); },
  };

  /* ========================================================= palette ==== */

  /* Custom properties are read raw — the browser does not resolve them for us
     — so a skin's scene tokens should be plain values, not expressions.

     A property can also read back as the empty string, which is the trap this
     guards: it happens whenever the skin's stylesheet has not applied yet, and
     an empty string handed to addColorStop() or a gradient throws, killing the
     frame without killing the loop. The result is two blank canvases and no
     error anywhere. So every value has a fallback, and a palette that came
     back incomplete is re-read on the next frame until it is whole. */

  let paletteStale = false;

  function resolveVar(cs, prop, fb) {
    const v = cs.getPropertyValue(prop).trim();
    if (v) return v;
    paletteStale = true;
    return fb || '#8a8a8a';
  }

  function readPalette() {
    const cs = getComputedStyle(document.documentElement);
    paletteStale = false;
    const out = {};
    for (const [key, prop] of Object.entries(vars)) {
      const fb = fallbacks[key];
      if (Array.isArray(prop)) {
        out[key] = prop.map((p, i) => resolveVar(cs, p, Array.isArray(fb) ? fb[i] : fb));
      } else {
        out[key] = resolveVar(cs, prop, Array.isArray(fb) ? fb[0] : fb);
      }
    }
    ctx.pal = out;
  }

  /* ========================================================== layout ==== */

  let dpr = 1;

  function resize() {
    dpr = Math.min(Math.max(devicePixelRatio || 1, 1), 2);
    ctx.w = Math.max(innerWidth, 1);
    ctx.h = Math.max(innerHeight, 1);
    for (const { el, ctx: c } of canvases.values()) {
      el.width = Math.round(ctx.w * dpr);
      el.height = Math.round(ctx.h * dpr);
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    readPalette();
    setup(ctx);
    emit('resize');
    if (ctx.reduced) renderOnce();
  }

  /** The places on screen a skin might want to aim something at. A skin asks
   *  for a role, not a selector, so this stays the only file coupled to the
   *  app's ids. */
  function anchor(what) {
    const el =
      what === 'transcript' ? document.getElementById('wrap') :
      what === 'scroller' ? document.getElementById('log') :
      what === 'composer' ? document.getElementById('input') :
      what === 'viewport' ? document.documentElement : null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0 ? r : null;
  }

  /* =========================================================== words ==== */

  /* Perchable text. Each handle keeps a live Range, so a word's box is read
     back at the moment it is needed rather than cached: scrolling the
     transcript therefore carries whatever is sitting on that word along with
     it, for free, and a word that is deleted, re-rendered or scrolled out of
     the log simply stops having a box. The harvest itself is the expensive
     half, so it is capped and cached for a beat. */

  let wordCache = [];
  let wordsAt = -1e4;

  function harvest(limit) {
    const root = document.getElementById('wrap');
    const scroller = document.getElementById('log');
    if (!root || !scroller) return [];
    const clip = scroller.getBoundingClientRect();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const out = [];
    let node;
    while ((node = walker.nextNode())) {
      if (out.length >= limit) break;
      const text = node.nodeValue;
      if (!text || text.length > 4000 || !/\S/.test(text)) continue;
      // A quick reject before touching layout: a text node whose own parent is
      // off screen has no word worth measuring.
      const parent = node.parentElement;
      if (!parent) continue;
      const pr = parent.getBoundingClientRect();
      if (pr.bottom < clip.top || pr.top > clip.bottom || pr.width < 8) continue;

      const re = /[^\s]{4,}/g;
      let m;
      while ((m = re.exec(text)) && out.length < limit) {
        // Sampling: on a long answer every word is a candidate, and a fairy
        // only ever needs a few dozen to choose between.
        if (Math.random() > 0.35) continue;
        const range = document.createRange();
        range.setStart(node, m.index);
        range.setEnd(node, m.index + m[0].length);
        const r = range.getBoundingClientRect();
        if (r.width < 18 || r.height < 8) continue;
        if (r.top < clip.top + 4 || r.bottom > clip.bottom - 4) continue;
        out.push(makeWord(range, clip));
      }
    }
    return out;
  }

  function makeWord(range, clip) {
    return {
      range,
      /** The word's box right now, or null if it is gone or scrolled away. */
      rect() {
        const n = range.startContainer;
        if (!n || !n.isConnected) return null;
        let r;
        try { r = range.getBoundingClientRect(); } catch { return null; }
        if (!r || r.width < 2) return null;
        const c = document.getElementById('log')?.getBoundingClientRect() || clip;
        if (r.bottom < c.top + 2 || r.top > c.bottom - 2) return null;
        return r;
      },
    };
  }

  function words(limit = 60) {
    if (ctx.t - wordsAt > 1.2 || !wordCache.length) {
      wordCache = harvest(limit);
      wordsAt = ctx.t;
    }
    return wordCache;
  }

  /* ============================================================ mode ==== */

  function readMode() {
    const send = document.getElementById('send');
    const wrap = document.getElementById('wrap');
    if (send && send.classList.contains('stop')) return 'busy';
    if (wrap && wrap.childElementCount === 0) return 'empty';
    return 'idle';
  }

  function syncMode() {
    const next = readMode();
    if (ctx.mode === 'done') {
      if (next === 'busy') setMode('busy');
      else if (ctx.modeAge > DONE_FOR) setMode('idle');
      return;
    }
    if (next === ctx.mode) return;
    setMode(ctx.mode === 'busy' && next !== 'busy' ? 'done' : next);
  }

  function setMode(m) {
    const prev = ctx.mode;
    ctx.mode = m;
    ctx.modeAge = 0;
    wordCache = [];
    wordsAt = -1e4;
    emit('mode', prev);
    if (ctx.reduced) renderOnce();
  }

  /* ========================================================= pointer ==== */

  let lastPointer = 0;

  function onPointerMove(e) {
    const now = performance.now();
    const dt = Math.min(Math.max((now - lastPointer) / 1000, 1 / 240), 0.1);
    lastPointer = now;
    pointer.vx = (e.clientX - pointer.x) / dt;
    pointer.vy = (e.clientY - pointer.y) / dt;
    if (!pointer.inside) { pointer.vx = pointer.vy = 0; }
    pointer.speed = Math.hypot(pointer.vx, pointer.vy);
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    pointer.inside = true;
  }
  function onPointerDown(e) {
    pointer.x = e.clientX; pointer.y = e.clientY; pointer.inside = true;
    pointer.downFor = 0.0001;
    emit('pointerdown', { x: e.clientX, y: e.clientY });
    if (ctx.reduced) renderOnce();
  }
  function onPointerUp() { pointer.downFor = 0; }
  function onPointerOut(e) {
    if (e.relatedTarget === null) {
      pointer.inside = false;
      pointer.vx = pointer.vy = pointer.speed = 0;
    }
  }

  /* ============================================================= run ==== */

  let raf = 0, last = 0;

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(Math.max((now - (last || now)) / 1000, 0), 0.05);
    last = now;
    ctx.t += dt;
    ctx.dt = dt;
    ctx.modeAge += dt;
    // A palette read before the skin's stylesheet applied comes back empty and
    // marks itself stale; re-read until it is whole, then leave it alone.
    if (paletteStale) { readPalette(); if (!paletteStale) setup(ctx); }
    syncMode();

    // The pointer decays toward rest rather than stopping dead, so "is the
    // cursor moving" is a question a skin can ask on any frame, not only on
    // the ones a pointermove happened to land in.
    pointer.vx -= pointer.vx * Math.min(dt * 6, 1);
    pointer.vy -= pointer.vy * Math.min(dt * 6, 1);
    pointer.speed = Math.hypot(pointer.vx, pointer.vy);
    if (pointer.downFor) pointer.downFor += dt;

    update(ctx, dt);
    draw(ctx);
  }

  function start() {
    if (raf || ctx.reduced || document.hidden) return;
    last = 0;
    raf = requestAnimationFrame(frame);
  }
  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }
  /** The still-motion path: one frame, on demand, with no time passing. */
  function renderOnce() {
    ctx.dt = 0;
    update(ctx, 0);
    draw(ctx);
  }

  /* ========================================================== wiring ==== */

  const onResize = () => resize();
  const onVisible = () => (document.hidden ? stop() : start());
  const onScheme = () => { readPalette(); resize(); };
  const onMotion = () => {
    ctx.reduced = reducedQ.matches;
    stop();
    if (ctx.reduced) renderOnce(); else start();
  };

  addEventListener('resize', onResize, { passive: true });
  addEventListener('pointermove', onPointerMove, { passive: true });
  addEventListener('pointerdown', onPointerDown, { passive: true });
  addEventListener('pointerup', onPointerUp, { passive: true });
  addEventListener('pointercancel', onPointerUp, { passive: true });
  document.addEventListener('pointerout', onPointerOut, { passive: true });
  document.addEventListener('visibilitychange', onVisible);
  darkQ.addEventListener('change', onScheme);
  reducedQ.addEventListener('change', onMotion);

  // The transcript's own box moves when the sidebar is dragged, the drawer
  // opens, or the composer grows a line — all of which change where a skin's
  // anchors are without the window ever resizing.
  const ro = new ResizeObserver(() => { emit('resize'); if (ctx.reduced) renderOnce(); });
  for (const el of [document.getElementById('wrap'), document.querySelector('main')]) {
    if (el) ro.observe(el);
  }

  // Word boxes go stale the instant the transcript changes or scrolls; the
  // handles re-measure themselves, but the harvest has to be thrown away.
  const invalidate = () => { wordCache = []; wordsAt = -1e4; };
  const mo = new MutationObserver(() => { invalidate(); syncMode(); if (ctx.reduced) renderOnce(); });
  const wrapEl = document.getElementById('wrap');
  const sendEl = document.getElementById('send');
  if (wrapEl) mo.observe(wrapEl, { childList: true, subtree: true, characterData: true });
  if (sendEl) mo.observe(sendEl, { attributes: true, attributeFilter: ['class'] });
  const scroller = document.getElementById('log');
  if (scroller) scroller.addEventListener('scroll', invalidate, { passive: true });

  resize();
  ctx.mode = readMode();
  if (ctx.reduced) renderOnce(); else start();

  /* Teardown. The loader calls this when another skin is picked, and what it
     leaves behind has to be indistinguishable from never having run. */
  return () => {
    stop();
    removeEventListener('resize', onResize);
    removeEventListener('pointermove', onPointerMove);
    removeEventListener('pointerdown', onPointerDown);
    removeEventListener('pointerup', onPointerUp);
    removeEventListener('pointercancel', onPointerUp);
    document.removeEventListener('pointerout', onPointerOut);
    document.removeEventListener('visibilitychange', onVisible);
    darkQ.removeEventListener('change', onScheme);
    reducedQ.removeEventListener('change', onMotion);
    scroller?.removeEventListener('scroll', invalidate);
    ro.disconnect();
    mo.disconnect();
    for (const { el } of canvases.values()) el.remove();
    canvases.clear();
  };
}
