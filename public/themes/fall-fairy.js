/* ============================================================================
   Fall Fairy — the scenery.

   All of the plumbing lives in scene-kit.js: canvases, resize, the frame loop,
   reduced motion, the pointer, the app's current mode, and the perchable text
   in the transcript. What is left here is the only part that is actually this
   skin — a forest, and the people in it.

   The fairies know about three things outside themselves:

     ctx.mode      empty -> she waits in the clearing
                   busy  -> the flock goes out with lanterns
                   done  -> they come home and light up the answer
     ctx.pointer   they are curious about a still cursor and startled by a
                   fast one; poking the page scatters whoever is near
     ctx.words()   they land on words. A perch is a live Range, so a fairy
                   sitting on a word rides it as the transcript scrolls, and
                   takes off when it is edited away.
   ========================================================================== */

import { createScene } from './scene-kit.js';

const TAU = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, k) => a + (b - a) * k;

function seeded(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function mount() {
  let forest = null;
  let leaves = [];
  let fairies = [];
  let sparks = [];
  let seat = null;

  return createScene({
    layers: [{ name: 'bg', z: -1 }, { name: 'fg', z: 5 }],
    vars: {
      skyHi: '--ff-sky-hi',
      skyLo: '--ff-sky-lo',
      hill: ['--ff-hill-far', '--ff-hill-mid', '--ff-hill-near'],
      tree: '--ff-tree',
      canopy: ['--ff-canopy-a', '--ff-canopy-b', '--ff-canopy-c'],
      leaf: ['--ff-leaf-a', '--ff-leaf-b', '--ff-leaf-c'],
      glow: '--ff-glow',
      wing: '--ff-wing',
      star: '--ff-star',
      night: '--ff-stars',
    },

    /* The daylight palette, hardcoded. Not a design decision — a floor. A
       custom property reads back empty until the skin's stylesheet applies,
       and an empty string reaching a gradient stop throws, which takes the
       frame down without taking the loop down: a silent, permanently blank
       canvas. The kit re-reads until the real palette arrives; this is what
       gets drawn in the meantime. */
    fallbacks: {
      skyHi: '#f7dcac', skyLo: '#e79a5c',
      hill: ['#c08a63', '#a4663f', '#7d452a'],
      tree: '#5c3220',
      canopy: ['#c85a24', '#d98b2b', '#9c6b2a'],
      leaf: ['#c0562c', '#dc9a33', '#8d7a2f'],
      glow: '#ffdf9e', wing: '#fff6de', star: '#fff3d2',
      night: '0',
    },

    setup(ctx) {
      forest = buildForest(ctx);
      seat = measureSeat(ctx);
      if (!leaves.length) leaves = seedLeaves(ctx);
      for (const l of leaves) l.color = pick(ctx.pal.leaf);
    },

    update(ctx, dt) {
      seat = measureSeat(ctx);
      const wind = Math.sin(ctx.t * 0.21) * 0.7 + Math.sin(ctx.t * 0.07) * 0.4;
      stepLeaves(ctx, dt, wind);
      stepSparks(ctx, dt);
      stepFairies(ctx, dt);
    },

    draw(ctx) {
      paintBackdrop(ctx);
      paintForeground(ctx);
    },
  });

  /* ======================================================== scenery ===== */

  function buildForest(ctx) {
    const { w: W, h: H } = ctx;
    const rng = seeded(0xfa11 + Math.round(W / 40));
    const ground = H * (W < 720 ? 0.8 : 0.74);

    const ridges = [0, 1, 2].map((i) => {
      const base = ground - (2 - i) * H * 0.075;
      const amp = H * (0.05 + i * 0.015);
      const pts = [];
      const step = W / 7;
      for (let x = -step; x <= W + step; x += step) pts.push({ x, y: base - rng() * amp });
      return { pts };
    });

    const trees = [];
    const count = Math.round(clamp(W / 190, 3, 9));
    for (let i = 0; i < count; i++) {
      const depth = rng();
      const h = H * lerp(0.17, 0.34, depth);
      trees.push({
        x: (i + 0.5 + rng() * 0.5 - 0.25) * (W / count),
        base: ground + H * 0.02 * rng(),
        h, depth,
        lean: (rng() - 0.5) * 0.12,
        canopy: Math.floor(rng() * 3),
        blobs: Array.from({ length: 4 }, () => ({
          dx: (rng() - 0.5) * h * 0.85,
          dy: -h * (0.72 + rng() * 0.3),
          r: h * (0.2 + rng() * 0.16),
        })),
        boughs: Array.from({ length: 3 }, (_, k) => ({
          at: 0.45 + k * 0.16, dir: k % 2 ? 1 : -1, len: h * (0.16 + rng() * 0.12),
        })),
      });
    }

    const props = [];
    const pcount = Math.round(clamp(W / 150, 4, 12));
    for (let i = 0; i < pcount; i++) {
      const kind = rng();
      props.push({
        x: (i + rng()) * (W / pcount),
        y: ground + H * (0.06 + rng() * 0.16),
        s: 0.6 + rng() * 0.8,
        kind: kind < 0.34 ? 'pumpkin' : kind < 0.6 ? 'shroom' : 'grass',
        tilt: (rng() - 0.5) * 0.24,
      });
    }

    const stars = Array.from({ length: 70 }, () => ({
      x: rng() * W, y: rng() * ground * 0.8, r: 0.4 + rng() * 1.2, p: rng() * TAU,
    }));

    return {
      ground, ridges, trees, props, stars,
      moon: { x: W * 0.78, y: H * 0.17, r: clamp(H * 0.05, 26, 64) },
    };
  }

  function paintBackdrop(ctx) {
    const bx = ctx.layer('bg');
    if (!bx || !forest) return;
    const { w: W, h: H, pal } = ctx;
    const { ground, ridges, trees, props, stars, moon } = forest;
    const night = pal.night === '1';

    const sky = bx.createLinearGradient(0, 0, 0, ground);
    sky.addColorStop(0, pal.skyHi);
    sky.addColorStop(0.72, pal.skyLo);
    sky.addColorStop(1, pal.hill[0]);
    bx.fillStyle = sky;
    bx.fillRect(0, 0, W, H);

    if (night) {
      bx.fillStyle = pal.star;
      for (const s of stars) {
        bx.globalAlpha = 0.25 + 0.55 * Math.abs(Math.sin(s.p + ctx.t * 0.6));
        dot(bx, s.x, s.y, s.r);
      }
      bx.globalAlpha = 1;
    }

    const halo = bx.createRadialGradient(moon.x, moon.y, moon.r * 0.5, moon.x, moon.y, moon.r * 3.4);
    halo.addColorStop(0, withAlpha(pal.glow, 0.55));
    halo.addColorStop(1, withAlpha(pal.glow, 0));
    bx.fillStyle = halo;
    dot(bx, moon.x, moon.y, moon.r * 3.4);
    bx.fillStyle = pal.glow;
    dot(bx, moon.x, moon.y, moon.r);

    ridges.forEach((ridge, i) => {
      bx.fillStyle = pal.hill[i];
      bx.beginPath();
      bx.moveTo(-40, H);
      bx.lineTo(ridge.pts[0].x, ridge.pts[0].y);
      for (let k = 1; k < ridge.pts.length; k++) {
        const p = ridge.pts[k], q = ridge.pts[k - 1];
        bx.quadraticCurveTo(q.x, q.y, (p.x + q.x) / 2, (p.y + q.y) / 2);
      }
      bx.lineTo(W + 40, H);
      bx.closePath();
      bx.fill();
    });

    for (const tree of [...trees].sort((a, b) => a.depth - b.depth)) paintTree(bx, pal, tree);

    bx.fillStyle = pal.hill[2];
    bx.fillRect(0, ground + H * 0.02, W, H);
    for (const p of props) paintProp(bx, ctx, p);

    for (const l of leaves) if (l.near < 0.55) paintLeaf(bx, l);
  }

  function paintTree(bx, pal, tree) {
    const { x, base, h, depth, lean, blobs, boughs } = tree;
    const topX = x + lean * h;
    const topY = base - h;

    bx.globalAlpha = lerp(0.72, 1, depth);
    bx.strokeStyle = pal.tree;
    bx.lineCap = 'round';
    bx.lineWidth = h * 0.09;
    bx.beginPath();
    bx.moveTo(x, base);
    bx.quadraticCurveTo(x + lean * h * 0.3, base - h * 0.5, topX, topY);
    bx.stroke();

    bx.lineWidth = h * 0.04;
    for (const b of boughs) {
      const px = lerp(x, topX, b.at);
      const py = lerp(base, topY, b.at);
      bx.beginPath();
      bx.moveTo(px, py);
      bx.quadraticCurveTo(px + b.dir * b.len * 0.6, py - b.len * 0.35, px + b.dir * b.len, py - b.len * 0.75);
      bx.stroke();
    }

    bx.fillStyle = pal.canopy[tree.canopy];
    for (const blob of blobs) dot(bx, topX + blob.dx, base + blob.dy, blob.r);
    bx.globalAlpha = 1;
  }

  function paintProp(bx, ctx, p) {
    const { pal } = ctx;
    const s = p.s * clamp(ctx.h / 900, 0.7, 1.3) * 26;
    bx.save();
    bx.translate(p.x, p.y);
    bx.rotate(p.tilt);
    if (p.kind === 'pumpkin') {
      bx.fillStyle = pal.canopy[0];
      ellipse(bx, 0, 0, s, s * 0.78);
      bx.fillStyle = withAlpha(pal.canopy[1], 0.85);
      ellipse(bx, -s * 0.42, 0, s * 0.36, s * 0.76);
      ellipse(bx, s * 0.42, 0, s * 0.36, s * 0.76);
      bx.strokeStyle = pal.tree;
      bx.lineWidth = s * 0.14;
      bx.beginPath();
      bx.moveTo(0, -s * 0.72);
      bx.lineTo(s * 0.1, -s * 1.05);
      bx.stroke();
    } else if (p.kind === 'shroom') {
      bx.fillStyle = withAlpha(pal.leaf[1], 0.9);
      bx.fillRect(-s * 0.1, -s * 0.5, s * 0.2, s * 0.75);
      bx.fillStyle = pal.leaf[0];
      bx.beginPath();
      bx.ellipse(0, -s * 0.5, s * 0.5, s * 0.34, 0, Math.PI, 0);
      bx.fill();
    } else {
      bx.strokeStyle = withAlpha(pal.hill[2], 0.9);
      bx.lineWidth = s * 0.1;
      bx.lineCap = 'round';
      for (let i = -1; i <= 1; i++) {
        bx.beginPath();
        bx.moveTo(i * s * 0.22, s * 0.2);
        bx.quadraticCurveTo(i * s * 0.4, -s * 0.2, i * s * 0.55 + s * 0.12, -s * 0.55);
        bx.stroke();
      }
    }
    bx.restore();
  }

  /* ======================================================== weather ===== */

  function seedLeaves(ctx) {
    const n = Math.round(clamp(ctx.w / 26, 14, 52));
    return Array.from({ length: n }, () => newLeaf(ctx, rand(-ctx.h, ctx.h)));
  }

  function newLeaf(ctx, y) {
    const near = Math.random();
    return {
      x: rand(-40, ctx.w + 40), y,
      s: lerp(5, 15, near), near,
      spin: rand(-2.2, 2.2), rot: rand(0, TAU),
      sway: rand(0.6, 1.5), phase: rand(0, TAU),
      vy: lerp(18, 58, near),
      color: pick(ctx.pal.leaf),
      gust: 0,
    };
  }

  function stepLeaves(ctx, dt, wind) {
    const p = ctx.pointer;
    for (const l of leaves) {
      // A leaf gets shoved aside by a cursor moving through it. Cheap, and it
      // is the first thing anyone tries.
      if (p.inside) {
        const dx = l.x - p.x, dy = l.y - p.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < 9000 && p.speed > 40) {
          const d = Math.sqrt(d2) || 1;
          const push = (1 - d / 95) * clamp(p.speed / 900, 0, 1.4);
          l.x += (dx / d) * push * 220 * dt;
          l.y += (dy / d) * push * 140 * dt;
          l.gust = Math.min(1.6, l.gust + push * 2.4 * dt);
          l.spin += (dx / d) * push * 6 * dt;
        }
      }
      l.y += (l.vy + l.gust * 40) * dt;
      l.x += (Math.sin(ctx.t * l.sway + l.phase) * 22 + wind * lerp(14, 46, l.near)) * dt;
      l.rot += l.spin * dt * (0.5 + l.gust);
      l.gust = Math.max(0, l.gust - dt * 0.6);
      if (l.y > ctx.h + 30 || l.x < -60 || l.x > ctx.w + 60) Object.assign(l, newLeaf(ctx, -30));
    }
  }

  function paintLeaf(c, l) {
    c.save();
    c.translate(l.x, l.y);
    c.rotate(l.rot);
    c.globalAlpha = lerp(0.45, 0.95, l.near);
    c.fillStyle = l.color;
    c.beginPath();
    c.moveTo(0, l.s * 0.6);
    c.quadraticCurveTo(-l.s * 0.9, l.s * 0.1, -l.s * 0.5, -l.s * 0.4);
    c.quadraticCurveTo(-l.s * 0.15, -l.s * 0.2, 0, -l.s * 0.75);
    c.quadraticCurveTo(l.s * 0.15, -l.s * 0.2, l.s * 0.5, -l.s * 0.4);
    c.quadraticCurveTo(l.s * 0.9, l.s * 0.1, 0, l.s * 0.6);
    c.fill();
    c.strokeStyle = 'rgb(0 0 0 / 0.18)';
    c.lineWidth = Math.max(0.6, l.s * 0.07);
    c.beginPath();
    c.moveTo(0, l.s * 0.6);
    c.lineTo(0, -l.s * 0.5);
    c.stroke();
    c.restore();
  }

  /* ======================================================== fairies ===== */

  function measureSeat(ctx) {
    const r = ctx.anchor('transcript');
    if (!r || ctx.mode !== 'empty') return null;
    return { x: r.left + r.width / 2, y: clamp(r.bottom - 10, 160, ctx.h - 20) };
  }

  function makeFairy(ctx, i) {
    return {
      x: rand(ctx.w * 0.2, ctx.w * 0.8), y: rand(ctx.h * 0.3, ctx.h * 0.7),
      vx: 0, vy: 0, tx: ctx.w / 2, ty: ctx.h / 2,
      s: rand(0.7, 1.15),
      flap: rand(0, TAU), bob: rand(0, TAU),
      hold: 0, retarget: 0, trail: 0,
      perch: null,        // { word, until, offset } while sitting on a word
      startled: 0,        // seconds of "get away from the cursor"
      idx: i,
    };
  }

  function flockSize(ctx) {
    const big = ctx.mode === 'busy' || ctx.mode === 'done';
    if (ctx.w < 720) return big ? 3 : 1;
    return big ? 6 : ctx.mode === 'empty' ? 3 : 2;
  }

  /** Where a fairy goes next when she is not sitting on anything. */
  function pickTarget(ctx, f) {
    const { w: W, h: H, pointer: p } = ctx;

    // A cursor that has come to rest is interesting; one that is being thrown
    // around is not. This is the whole of "the fairies notice you".
    const calm = p.inside && p.speed < 90;
    if (calm && f.startled <= 0 && ctx.mode !== 'busy' && Math.random() < 0.5) {
      const a = rand(0, TAU);
      const r = rand(46, 120);
      f.tx = clamp(p.x + Math.cos(a) * r, 24, W - 24);
      f.ty = clamp(p.y + Math.sin(a) * r * 0.8, 50, H - 30);
      f.retarget = rand(0.8, 1.8);
      f.hold = Math.random() < 0.5 ? rand(0.3, 0.9) : 0;
      return;
    }

    if (ctx.mode === 'busy') {
      const edge = Math.random() < 0.55;
      f.tx = edge
        ? (Math.random() < 0.5 ? rand(0.04, 0.22) : rand(0.78, 0.96)) * W
        : rand(0.1, 0.9) * W;
      f.ty = rand(0.12, 0.85) * H;
      f.retarget = rand(0.9, 2.4);
      f.hold = Math.random() < 0.35 ? rand(0.3, 0.9) : 0;
      return;
    }

    if (ctx.mode === 'done') {
      const r = ctx.anchor('transcript');
      const cx = r ? r.left + r.width / 2 : W / 2;
      const cy = r ? clamp(r.bottom - 60, 100, H - 120) : H / 2;
      f.tx = cx + rand(-90, 90);
      f.ty = cy + rand(-70, 40);
      f.retarget = rand(0.5, 1.1);
      f.hold = 0;
      return;
    }

    const c = seat || { x: W / 2, y: H * 0.62 };
    const a = rand(0, TAU);
    const r = rand(70, 190) * clamp(W / 900, 0.6, 1.2);
    f.tx = clamp(c.x + Math.cos(a) * r, 40, W - 40);
    f.ty = clamp(c.y - 60 + Math.sin(a) * r * 0.55, 80, H - 60);
    f.retarget = rand(2.2, 4.5);
    f.hold = Math.random() < 0.4 ? rand(0.6, 1.6) : 0;
  }

  /** How long a fairy stays on a word, by what she is doing there. Skimming
   *  for an answer is quick; there is nothing to read on an empty page. */
  function perchDwell(mode) {
    if (mode === 'busy') return rand(0.45, 1.1);
    if (mode === 'done') return rand(1.6, 3.4);
    return rand(1.2, 3.2);
  }

  function tryPerch(ctx, f) {
    const candidates = ctx.words(60);
    if (!candidates.length) return;
    // A few tries, because any given handle may have scrolled away since the
    // harvest and the cheapest way to know is to ask it.
    for (let i = 0; i < 5; i++) {
      const word = pick(candidates);
      const r = word.rect();
      if (!r) continue;
      f.perch = {
        word,
        until: ctx.t + perchDwell(ctx.mode),
        // Where along the word she stands, so two fairies do not share a spot.
        offset: rand(0.2, 0.8),
      };
      return;
    }
  }

  function stepFairies(ctx, dt) {
    const { w: W, h: H, pointer: p, mode } = ctx;
    const want = flockSize(ctx);
    while (fairies.length < want) fairies.push(makeFairy(ctx, fairies.length));
    if (fairies.length > want) fairies.length = want;

    const speed = mode === 'busy' ? 1 : mode === 'done' ? 1.25 : 0.42;
    const accel = mode === 'busy' ? 780 : mode === 'done' ? 900 : 260;
    const drag = mode === 'empty' ? 2.6 : 1.9;

    for (const f of fairies) {
      f.startled = Math.max(0, f.startled - dt);

      // --- the cursor, up close ---------------------------------------
      if (p.inside) {
        const dx = f.x - p.x, dy = f.y - p.y;
        const d = Math.hypot(dx, dy) || 1;
        if (d < 52 && p.speed > 140) {
          // Swatted at. She bolts, and drops whatever she was sitting on.
          f.startled = rand(0.9, 1.8);
          f.perch = null;
          f.hold = 0;
          f.vx += (dx / d) * 520;
          f.vy += (dy / d) * 420 - 60;
          f.retarget = 0;
          if (sparks.length < 300) burst(f.x, f.y, 6, 90);
        } else if (d < 90 && f.startled <= 0 && p.speed < 60 && mode !== 'busy') {
          // A still cursor gets hovered around rather than fled from.
          f.vx += (-dx / d) * 40 * dt * 60 * 0.02;
          f.vy += (-dy / d) * 40 * dt * 60 * 0.02;
        }
      }

      // --- sitting on a word -------------------------------------------
      if (f.perch) {
        const r = f.perch.word.rect();
        if (!r || ctx.t > f.perch.until || f.startled > 0) {
          if (r && ctx.t > f.perch.until) {
            // A clean take-off leaves a little dust on the word.
            burst(f.x, f.y, 4, 60);
          }
          f.perch = null;
          f.retarget = 0;
        } else {
          // She rides the word: its box is read fresh every frame, so
          // scrolling, editing or a re-render carries her with it.
          const tx = r.left + r.width * f.perch.offset;
          const ty = r.top - 2;
          f.x = lerp(f.x, tx, clamp(dt * 9, 0, 1));
          f.y = lerp(f.y, ty, clamp(dt * 9, 0, 1));
          f.vx = lerp(f.vx, 0, clamp(dt * 8, 0, 1));
          f.vy = lerp(f.vy, 0, clamp(dt * 8, 0, 1));
          f.flap += dt * 5;
          f.trail -= dt;
          if (f.trail <= 0 && sparks.length < 260) {
            f.trail = rand(0.18, 0.4);
            sparks.push(newSpark(f.x + rand(-4, 4), f.y + rand(-1, 3), rand(-6, 6), rand(2, 10), rand(0.8, 1.6)));
          }
          continue;
        }
      }

      // --- flying -------------------------------------------------------
      f.retarget -= dt;
      if (f.retarget <= 0) {
        pickTarget(ctx, f);
        // Landing is a decision made between flights, and only when there is
        // something under the cursor's world to land on.
        const wantsPerch =
          f.startled <= 0 &&
          mode !== 'empty' &&
          Math.random() < (mode === 'busy' ? 0.3 : mode === 'done' ? 0.55 : 0.35);
        if (wantsPerch) tryPerch(ctx, f);
      }

      if (f.perch) {
        const r = f.perch.word.rect();
        if (r) { f.tx = r.left + r.width * f.perch.offset; f.ty = r.top - 2; }
        else f.perch = null;
      }

      if (f.hold > 0 && !f.perch) {
        f.hold -= dt;
        f.vx *= 1 - clamp(dt * 5, 0, 1);
        f.vy *= 1 - clamp(dt * 5, 0, 1);
      } else {
        const dx = f.tx - f.x, dy = f.ty - f.y;
        const d = Math.hypot(dx, dy) || 1;
        if (d < 26 && !f.perch) pickTarget(ctx, f);
        const push = f.startled > 0 ? accel * 0.4 : accel;
        f.vx += (dx / d) * push * dt;
        f.vy += (dy / d) * push * dt;
      }

      f.vx -= f.vx * drag * dt;
      f.vy -= f.vy * drag * dt;
      const sp = f.startled > 0 ? speed * 1.6 : speed;
      f.x += f.vx * dt * sp;
      f.y += f.vy * dt * sp + Math.sin(ctx.t * 2.4 + f.bob) * 8 * dt;
      f.x = clamp(f.x, 16, W - 16);
      f.y = clamp(f.y, 40, H - 24);

      const effort = clamp(Math.hypot(f.vx, f.vy) / 260, 0.35, 1.8);
      f.flap += dt * (22 + effort * 26);

      f.trail -= dt;
      if (f.trail <= 0 && sparks.length < 260) {
        f.trail = mode === 'busy' ? 0.028 : 0.07;
        sparks.push(newSpark(
          f.x + rand(-3, 3), f.y + rand(-2, 6),
          -f.vx * 0.06 + rand(-8, 8), -f.vy * 0.06 + rand(4, 18),
          rand(0.5, 1.2) * f.s,
        ));
      }
    }
  }

  /* ========================================================= sparks ===== */

  function newSpark(x, y, vx, vy, r) {
    return { x, y, vx, vy, life: rand(0.5, 1.3), max: 1.3, r: clamp(r, 0.6, 3.2) };
  }

  function burst(x, y, n, force = 180) {
    for (let i = 0; i < n && sparks.length < 400; i++) {
      const a = rand(0, TAU), v = rand(force * 0.25, force);
      sparks.push(newSpark(x, y, Math.cos(a) * v, Math.sin(a) * v - 30, rand(1, 3)));
    }
  }

  function stepSparks(ctx, dt) {
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i];
      s.life -= dt;
      if (s.life <= 0) { sparks.splice(i, 1); continue; }
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.vy += 26 * dt;
      s.vx -= s.vx * 1.6 * dt;
    }
  }

  /* ========================================================== paint ===== */

  function paintForeground(ctx) {
    const fx = ctx.layer('fg');
    if (!fx) return;
    ctx.clear('fg');

    for (const l of leaves) if (l.near >= 0.55) paintLeaf(fx, l);

    fx.globalCompositeOperation = 'lighter';

    // A word with someone standing on it catches her light. Additive and very
    // faint: it brightens the glyphs underneath rather than covering them, so
    // the text is never less readable for having a fairy on it.
    for (const f of fairies) {
      if (!f.perch) continue;
      const r = f.perch.word.rect();
      if (!r) continue;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const g = fx.createRadialGradient(cx, cy, 0, cx, cy, r.width * 0.9);
      g.addColorStop(0, withAlpha(ctx.pal.glow, 0.17));
      g.addColorStop(1, withAlpha(ctx.pal.glow, 0));
      fx.fillStyle = g;
      fx.fillRect(cx - r.width, cy - r.height * 1.6, r.width * 2, r.height * 3.2);
    }

    for (const s of sparks) {
      const k = clamp(s.life / s.max, 0, 1);
      fx.globalAlpha = k * 0.85;
      fx.fillStyle = ctx.pal.glow;
      dot(fx, s.x, s.y, s.r * (0.4 + k));
    }
    fx.globalAlpha = 1;
    fx.globalCompositeOperation = 'source-over';

    if (ctx.mode === 'empty') paintSeated(ctx, fx);
    for (const f of fairies) paintFairy(ctx, fx, f);
  }

  function paintFairy(ctx, c, f) {
    const { pal } = ctx;
    const perched = !!f.perch;
    const s = f.s * clamp(ctx.h / 820, 0.8, 1.35) * 15;
    const beat = perched ? Math.sin(f.flap) * 0.25 : Math.sin(f.flap);
    const tilt = perched ? 0 : clamp(f.vx / 420, -0.5, 0.5);

    c.save();
    c.translate(f.x, f.y - (perched ? s * 1.1 : 0));
    c.rotate(tilt * 0.5);

    const halo = c.createRadialGradient(0, 0, 0, 0, 0, s * 3.6);
    halo.addColorStop(0, withAlpha(pal.glow, ctx.mode === 'busy' ? 0.5 : 0.36));
    halo.addColorStop(1, withAlpha(pal.glow, 0));
    c.fillStyle = halo;
    dot(c, 0, 0, s * 3.6);

    c.fillStyle = withAlpha(pal.wing, perched ? 0.5 : 0.62);
    for (const dir of [-1, 1]) {
      c.save();
      c.scale(dir, 1);
      c.rotate((perched ? -0.75 : -0.35) + beat * 0.5);
      ellipse(c, s * 0.62, -s * 0.5, s * 0.55 * (0.55 + 0.45 * Math.abs(beat)), s * 0.95);
      c.rotate(0.75);
      ellipse(c, s * 0.5, s * 0.18, s * 0.38 * (0.5 + 0.5 * Math.abs(beat)), s * 0.6);
      c.restore();
    }

    c.fillStyle = withAlpha(pal.wing, 0.96);
    c.beginPath();
    c.moveTo(0, -s * 0.25);
    c.quadraticCurveTo(s * 0.42, s * 0.2, 0, s * 1.05);
    c.quadraticCurveTo(-s * 0.42, s * 0.2, 0, -s * 0.25);
    c.fill();

    // Legs: tucked while flying, planted while perched.
    c.strokeStyle = withAlpha(pal.wing, 0.9);
    c.lineWidth = s * 0.16;
    c.lineCap = 'round';
    c.beginPath();
    if (perched) {
      c.moveTo(-s * 0.12, s * 0.95);
      c.lineTo(-s * 0.14, s * 1.6);
      c.moveTo(s * 0.12, s * 0.95);
      c.lineTo(s * 0.14, s * 1.6);
    } else {
      c.moveTo(-s * 0.1, s * 0.95);
      c.lineTo(-s * 0.3, s * 1.5 + beat * s * 0.12);
      c.moveTo(s * 0.1, s * 0.95);
      c.lineTo(s * 0.32, s * 1.45 - beat * s * 0.12);
    }
    c.stroke();

    c.fillStyle = withAlpha(pal.wing, 1);
    dot(c, 0, -s * 0.62, s * 0.4);
    c.fillStyle = pal.canopy[f.idx % pal.canopy.length];
    c.beginPath();
    c.arc(0, -s * 0.72, s * 0.42, Math.PI * 1.05, Math.PI * 1.95);
    c.fill();

    if (ctx.mode === 'busy') {
      const lx = s * 0.75, ly = s * 0.55;
      c.strokeStyle = withAlpha(pal.wing, 0.8);
      c.lineWidth = s * 0.1;
      c.beginPath();
      c.moveTo(s * 0.25, s * 0.1);
      c.lineTo(lx, ly - s * 0.25);
      c.stroke();
      const lg = c.createRadialGradient(lx, ly, 0, lx, ly, s * 1.5);
      lg.addColorStop(0, withAlpha(pal.glow, 0.95));
      lg.addColorStop(1, withAlpha(pal.glow, 0));
      c.fillStyle = lg;
      dot(c, lx, ly, s * 1.5);
      c.fillStyle = pal.glow;
      dot(c, lx, ly, s * 0.26);
    }

    c.restore();
  }

  function paintSeated(ctx, c) {
    if (!seat) return;
    const { pal, t } = ctx;
    const s = clamp(ctx.h / 820, 0.75, 1.3) * 34;
    const bobY = Math.sin(t * 0.9) * s * 0.06;
    const beat = Math.sin(t * 3.2);

    c.save();
    c.translate(seat.x, seat.y - s * 0.2);

    const halo = c.createRadialGradient(0, -s * 0.9, 0, 0, -s * 0.9, s * 3.2);
    halo.addColorStop(0, withAlpha(pal.glow, 0.34));
    halo.addColorStop(1, withAlpha(pal.glow, 0));
    c.fillStyle = halo;
    dot(c, 0, -s * 0.9, s * 3.2);

    c.fillStyle = pal.canopy[0];
    ellipse(c, 0, 0, s, s * 0.78);
    c.fillStyle = withAlpha(pal.canopy[1], 0.9);
    ellipse(c, -s * 0.44, 0, s * 0.34, s * 0.76);
    ellipse(c, s * 0.44, 0, s * 0.34, s * 0.76);
    c.strokeStyle = pal.tree;
    c.lineWidth = s * 0.12;
    c.lineCap = 'round';
    c.beginPath();
    c.moveTo(0, -s * 0.74);
    c.quadraticCurveTo(s * 0.12, -s * 0.95, s * 0.02, -s * 1.08);
    c.stroke();

    c.translate(0, bobY);

    c.fillStyle = withAlpha(pal.wing, 0.5);
    for (const dir of [-1, 1]) {
      c.save();
      c.scale(dir, 1);
      c.rotate(-0.45 + beat * 0.08);
      ellipse(c, s * 0.52, -s * 1.25, s * 0.3, s * 0.72);
      c.rotate(0.55);
      ellipse(c, s * 0.42, -s * 0.85, s * 0.2, s * 0.45);
      c.restore();
    }

    c.fillStyle = withAlpha(pal.wing, 0.97);
    c.beginPath();
    c.moveTo(-s * 0.18, -s * 1.28);
    c.quadraticCurveTo(s * 0.3, -s * 0.9, s * 0.1, -s * 0.5);
    c.quadraticCurveTo(-s * 0.3, -s * 0.62, -s * 0.18, -s * 1.28);
    c.fill();

    c.strokeStyle = withAlpha(pal.wing, 0.95);
    c.lineWidth = s * 0.13;
    c.beginPath();
    c.moveTo(s * 0.02, -s * 0.55);
    c.quadraticCurveTo(s * 0.34, -s * 0.34, s * 0.3 + Math.sin(t * 1.6) * s * 0.06, s * 0.1);
    c.moveTo(-s * 0.06, -s * 0.55);
    c.quadraticCurveTo(s * 0.22, -s * 0.28, s * 0.16 + Math.sin(t * 1.6 + 0.8) * s * 0.06, s * 0.14);
    c.stroke();

    // Chin propped on one hand. She has been waiting a while.
    c.beginPath();
    c.moveTo(-s * 0.16, -s * 1.15);
    c.quadraticCurveTo(s * 0.18, -s * 1.1, s * 0.12, -s * 1.32);
    c.stroke();

    c.fillStyle = withAlpha(pal.wing, 1);
    dot(c, -s * 0.04, -s * 1.5, s * 0.26);
    c.fillStyle = pal.canopy[1];
    c.beginPath();
    c.arc(-s * 0.04, -s * 1.56, s * 0.29, Math.PI * 0.98, Math.PI * 2.06);
    c.fill();

    c.restore();
  }
}

/* ---------------------------------------------------------------- utils */

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function dot(c, x, y, r) {
  c.beginPath();
  c.arc(x, y, Math.max(r, 0.1), 0, TAU);
  c.fill();
}

function ellipse(c, x, y, rx, ry) {
  c.beginPath();
  c.ellipse(x, y, Math.max(rx, 0.1), Math.max(ry, 0.1), 0, 0, TAU);
  c.fill();
}

/** The palette arrives as whatever the CSS said. Both hex and the browser's
 *  own rgb() form need an alpha applied without parsing colour syntax by hand. */
function withAlpha(color, alpha) {
  const c = (color || '').trim();
  if (c.startsWith('#')) {
    const h = c.slice(1);
    const full = h.length === 3 ? h.split('').map((x) => x + x).join('') : h.slice(0, 6);
    const n = parseInt(full, 16);
    if (Number.isNaN(n)) return c;
    return `rgb(${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255} / ${alpha})`;
  }
  if (c.startsWith('rgb')) {
    const nums = c.match(/[\d.]+/g);
    if (nums && nums.length >= 3) return `rgb(${nums[0]} ${nums[1]} ${nums[2]} / ${alpha})`;
  }
  return c || '#ffd98a';
}
