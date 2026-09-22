/**
 * Rendering the transcript: turns, messages, thinking, tool steps, usage
 * lines, notices and errors -- plus replaying a stored history into the same
 * shapes a live stream would have produced.
 */
import { renderMarkdown } from './md.js';
import { $, el } from './dom.js';
import { state } from './state.js';
import { openChat } from './chat.js';
import { addQuestion } from './outline.js';

const log = $('log');
const wrap = $('wrap');

let pinned = true;
log.addEventListener('scroll', () => {
  pinned = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
});
export function scroll() { if (pinned) log.scrollTop = log.scrollHeight; }
// Switching chats always lands on the newest message, regardless of whether
// the chat left open before it had been scrolled up to read older ones.
export function pinToBottom() { pinned = true; }

/**
 * One assistant turn: the work that led to the answer, and then the answer.
 *
 * Which prose block is the answer cannot be known while it streams -- narration
 * between two tool calls looks exactly like a conclusion, and the model does
 * not announce which is which. So the newest prose is held as the candidate
 * answer and demoted into the work the moment another thought or tool call
 * follows it. Whatever is still standing when the turn ends is the answer.
 *
 * The work is a disclosure rather than a plain rail: open and naming the step
 * it is on while the turn runs, collapsed behind a one-line recap once there
 * is an answer to read instead.
 */
export function addTurn() {
  const box = el('div', 'turn');
  wrap.appendChild(box);

  const work = el('details', 'work live');
  work.open = true;
  const sum = el('summary');
  const act = el('span', 'act');
  const tally = el('span', 'tally');
  sum.append(act, tally);
  const body = el('div', 'work-body');
  work.append(sum, body);

  const started = Date.now();
  let steps = 0;
  let mounted = false;
  let candidate = null;
  // Every round's raw usage, kept so the turn can be summed at the end. The
  // per-round lines live inside the work, which is collapsed by default; what a
  // multi-round turn actually cost is only visible once they are added up.
  const raws = [];

  // The work only appears once there is work. A plain answer keeps the shape it
  // always had, with no empty disclosure sitting above it.
  const mount = () => {
    if (!mounted) { box.appendChild(work); mounted = true; }
    return body;
  };

  // Prose that turned out to be narration joins the work, in the order it was
  // spoken, instead of staying up top competing with the real answer.
  const demote = () => {
    if (!candidate) return;
    mount().appendChild(candidate);
    candidate.classList.add('note');
    candidate.querySelector('.who').textContent = 'note';
    candidate = null;
  };

  const label = (text) => { act.textContent = text; scroll(); };
  label('starting');

  return {
    el: box,
    /** Container for thinking and tool steps; mounts the work on first use. */
    work: mount,
    /** Where a usage line goes: with the work when there is any, else inline. */
    meta: () => (mounted ? body : box),
    /** One round's usage: shown where it happened, and banked for the total. */
    usage(raw) {
      raws.push(raw);
      addUsage(tallyUsage([raw]), mounted ? body : box);
    },
    status: label,
    step() {
      steps++;
      tally.textContent = `${steps} step${steps === 1 ? '' : 's'}`;
    },
    /** Something followed the last prose block, so it was never the answer. */
    interrupt: demote,
    prose() {
      demote();
      const a = addAssistant(box);
      candidate = a.node;
      return a;
    },
    finish({ replayed = false } = {}) {
      if (candidate) {
        candidate.classList.add('final');
        candidate.querySelector('.who').textContent = 'answer';
        candidate = null;
      }
      // Under the answer, not inside the work: a turn that replayed a growing
      // prefix across N rounds costs far more than its last round suggests, and
      // the last round is the only number the collapsed view would show.
      if (raws.length > 1) {
        const n = raws.length;
        addUsage(tallyUsage(raws), box, { total: true, label: `turn total (${n} rounds)` });
      }
      if (!mounted) return;
      work.classList.remove('live');
      work.open = false;
      act.textContent = 'work';
      const bits = [`${steps} step${steps === 1 ? '' : 's'}`];
      // Elapsed time is real only for a turn we watched happen.
      if (!replayed) bits.push(`${((Date.now() - started) / 1000).toFixed(1)}s`);
      tally.textContent = bits.join(' · ');
    }
  };
}

/** The live one-liner for the work summary: which tool, on what. */
export function statusOf(name, args) {
  const short = name.replace(/^[^_]+__/, '');
  const first = Object.values(args || {})[0];
  if (first == null) return short;
  const arg = String(typeof first === 'object' ? JSON.stringify(first) : first);
  return arg ? `${short} ${arg}` : short;
}

export function addUser(text, seq, attachments, images) {
  const m = el('div', 'msg user');
  m.innerHTML = '<div class="who">you</div>';
  const b = el('div', 'body');
  b.textContent = text;
  m.appendChild(b);

  if (attachments?.length) {
    const box = el('div', 'msg-attachments');
    for (const a of attachments) {
      const chip = el('span', 'attachment-chip');
      chip.textContent = `${a.filename} (${a.char_len.toLocaleString('en-US')} chars)`;
      box.appendChild(chip);
    }
    m.appendChild(box);
  }

  if (images?.length) {
    const box = el('div', 'msg-images');
    for (const img of images) {
      const thumb = el('img', 'msg-image-thumb');
      // A freshly staged image carries its own base64 payload; one replayed
      // from a reopened chat carries the stored {mime, data} shape instead.
      thumb.src = img.dataBase64
        ? `data:${img.mime};base64,${img.dataBase64}`
        : `data:${img.mime};base64,${img.data}`;
      thumb.alt = img.filename || 'attached image';
      box.appendChild(thumb);
    }
    m.appendChild(box);
  }

  // A question that is in the store can be rewritten. One that has not been
  // saved yet (the one being sent right now) cannot, so it gets no controls.
  if (seq != null) {
    const bar = el('div', 'msg-tools');
    const edit = el('button', 'linkish');
    edit.type = 'button';
    edit.textContent = 'edit';
    edit.title = 'Rewrite this question and answer it again';
    edit.onclick = () => beginEdit(m, b, text, seq);

    const again = el('button', 'linkish');
    again.type = 'button';
    again.textContent = 'retry';
    again.title = 'Answer this question again from scratch';
    // Resubmitting the same text at the same point. One mechanism for both
    // buttons, so retry means "this question" rather than "the newest one".
    again.onclick = () => rewind({ seq, message: text });

    bar.append(edit, again);
    m.appendChild(bar);
  }

  wrap.appendChild(m);
  addQuestion(m, text);
  scroll();
}

/** Swaps a question for a textarea, in place. Escape or cancel puts it back. */
function beginEdit(msg, body, text, seq) {
  if (state.busy || msg.querySelector('textarea')) return;
  const box = el('div', 'edit-box');
  const area = el('textarea');
  area.value = text;
  area.rows = Math.min(12, text.split('\n').length + 1);

  const save = el('button', 'primary');
  save.type = 'button';
  save.textContent = 'save & resubmit';
  const cancel = el('button', 'linkish');
  cancel.type = 'button';
  cancel.textContent = 'cancel';

  const close = () => { box.remove(); body.hidden = false; msg.classList.remove('editing'); };
  cancel.onclick = close;
  save.onclick = () => {
    const next = area.value.trim();
    if (!next) return;
    if (next === text) return close();
    return rewind({ seq, message: next });
  };
  area.onkeydown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save.onclick(); }
  };

  const row = el('div', 'edit-actions');
  row.append(save, cancel);
  box.append(area, row);
  body.hidden = true;
  msg.classList.add('editing');
  msg.appendChild(box);
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);
}

/**
 * Rewinds the conversation and runs it forward again.
 *
 * Everything after the rewind point is gone -- there is no second branch kept
 * to switch back to. Reopening the chat is what redraws it: the server has
 * already truncated the transcript, and `openChat` replays what is left and
 * rejoins the run that is now producing the rest.
 */
async function rewind(payload) {
  if (state.busy || !state.chat.id) return;
  const res = await fetch(`/api/chats/${state.chat.id}/edit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const out = await res.json().catch(() => ({ error: `${res.status}` }));
  if (!res.ok) return addError(out.error);
  // The run is already going; openChat replays the rewound transcript and
  // attaches to it, exactly as a reload mid-turn would.
  const id = state.chat.id;
  await openChat(id);
  return undefined;
}

export function addAssistant(parent) {
  const m = el('div', 'msg assistant');
  m.innerHTML = '<div class="who">assistant</div>';
  const b = el('div', 'md');
  m.appendChild(b);
  (parent || wrap).appendChild(m);
  let raw = '';
  let queued = false;
  const paint = () => { queued = false; b.innerHTML = renderMarkdown(raw); scroll(); };
  return {
    // The turn moves this block between the work and the answer slot, so it
    // hands out its element rather than assuming where it lives.
    node: m,
    // Re-render on a frame rather than per token: markdown is whole-document,
    // and a fast stream would otherwise reparse hundreds of times a second.
    push(delta) {
      raw += delta;
      if (!queued) { queued = true; requestAnimationFrame(paint); }
    },
    set(text) { raw = text; paint(); }
  };
}

export function addThinking(parent) {
  const d = el('details', 'think');
  const s = el('summary');
  const body = el('div', 'think-body');
  d.append(s, body);
  d.open = true;
  (parent || wrap).appendChild(d);
  const started = Date.now();
  let raw = '';
  const label = (done) => {
    s.textContent = done
      ? `thought for ${((Date.now() - started) / 1000).toFixed(1)}s`
      : 'thinking…';
  };
  label(false);
  return {
    push(delta) { raw += delta; body.textContent = raw; body.scrollTop = body.scrollHeight; scroll(); },
    set(text, collapsed) { raw = text; body.textContent = raw; label(true); d.open = !collapsed; },
    // Collapse once the visible answer starts: the reasoning stays one click away.
    done() { if (raw) { label(true); d.open = false; } else d.remove(); }
  };
}

export function addSteps(parent) {
  const box = el('div', 'steps');
  (parent || wrap).appendChild(box);
  const rows = new Map();
  return {
    add(id, name, args) {
      const d = el('details', 'step');
      const s = el('summary');
      const n = el('span', 'name');
      n.textContent = name.replace(/^[^_]+__/, '');
      const a = el('span', 'arg');
      const first = Object.values(args || {})[0];
      a.textContent = first == null ? '' : String(typeof first === 'object' ? JSON.stringify(first) : first);
      const ms = el('span', 'ms');
      ms.textContent = '…';
      s.append(n, a, ms);
      const pre = el('pre');
      pre.textContent = JSON.stringify(args, null, 2);
      d.append(s, pre);
      box.appendChild(d);
      rows.set(id, { d, ms, pre, t0: Date.now() });
      scroll();
    },
    finish(id, result, compacted) {
      const row = rows.get(id);
      if (!row) return;
      row.ms.textContent = `${((Date.now() - row.t0) / 1000).toFixed(1)}s`;
      if (/^Error/.test(result)) row.d.classList.add('bad');
      // The transcript always keeps the full output; compaction only shortens
      // what the model is sent, so the badge is the only visible difference.
      if (compacted) row.d.classList.add('compacted');
      row.pre.textContent += '\n\n' + result;
      scroll();
    },
    // Timings are meaningless on a replayed transcript.
    quiet() { for (const r of rows.values()) r.ms.textContent = ''; }
  };
}

/**
 * Cache reporting is not standardised. Each provider spells it differently, and
 * some report nothing at all -- in which case a hit is invisible, not absent.
 *   OpenAI / Gemini / OpenRouter : prompt_tokens_details.cached_tokens
 *   Anthropic                    : cache_read_input_tokens (+ creation, billed extra)
 *   DeepSeek                     : prompt_cache_hit_tokens / prompt_cache_miss_tokens
 */
function cacheReads(u) {
  return u.prompt_tokens_details?.cached_tokens
    ?? u.input_tokens_details?.cached_tokens
    ?? u.cache_read_input_tokens
    ?? u.prompt_cache_hit_tokens
    ?? 0;
}

function cacheWrites(u) {
  return u.cache_creation_input_tokens
    ?? u.cache_write_tokens
    ?? u.prompt_tokens_details?.cache_write_tokens
    ?? u.prompt_tokens_details?.cache_creation_tokens
    ?? u.input_tokens_details?.cache_write_tokens
    ?? 0;
}

/** Folds one or more raw usage objects into the numbers we display. */
export function tally(raws) {
  const t = { in: 0, out: 0, cached: 0, written: 0, discount: 0, reported: false, raw: raws, provider: null, providers: [] };
  for (const u of raws) {
    if (u.provider) {
      t.provider = u.provider;
      // Distinct upstreams, in the order they served. A turn split across two
      // of them cannot cache between rounds, and summing would otherwise hide
      // that behind whichever one happened to serve last.
      if (!t.providers.includes(u.provider)) t.providers.push(u.provider);
    }
    t.in += u.prompt_tokens ?? u.input_tokens ?? 0;
    t.out += u.completion_tokens ?? u.output_tokens ?? 0;
    t.cached += cacheReads(u);
    t.written += cacheWrites(u);
    t.discount += Number(u.cache_discount || 0);
    // Distinguish "the provider said zero" from "the provider said nothing".
    if (u.prompt_tokens_details || u.input_tokens_details || u.cache_read_input_tokens != null
        || u.cache_write_tokens != null || u.prompt_cache_hit_tokens != null) t.reported = true;
  }
  return t;
}

const fmt = (n) => n.toLocaleString('en-US');

// `addTurn` has a local `tally` (the step-count span), so it reaches this one
// by alias rather than by name.
const tallyUsage = tally;

export function addUsage(u, parent, { label = null, total = false } = {}) {
  const bits = [];
  if (label) bits.push(label);
  bits.push(`${fmt(u.in)} in`, `${fmt(u.out)} out`);
  if (u.cached) {
    const pct = u.in ? Math.round((u.cached / u.in) * 100) : 0;
    bits.push(`${fmt(u.cached)} cached (${pct}%)`);
  }
  if (u.written) bits.push(`${fmt(u.written)} written`);
  if (u.discount) bits.push(`cache saved ${u.discount.toFixed(4)}`);
  if (!u.cached && !u.written) bits.push(u.reported ? 'no cache hit' : 'cache not reported');
  // Worth a line of its own: a round served by a different upstream has a cold
  // cache through no fault of the prefix, and that is only visible here.
  if (u.providers?.length) bits.push(`via ${u.providers.join(' + ')}`);
  else if (u.provider) bits.push(`via ${u.provider}`);
  const line = el('div', total ? 'usage usage-total' : 'usage');
  line.textContent = bits.join(' / ');
  // The raw usage objects, for when a provider reports something we do not read.
  line.title = JSON.stringify(u.raw, null, 2);
  (parent || wrap).appendChild(line);
  scroll();
}

export function addNotice(text, parent) {
  const n = el('div', 'notice');
  n.textContent = text;
  (parent || wrap).appendChild(n);
  scroll();
}

export function addError(text, parent) {
  const e = el('div', 'err');
  e.textContent = text;
  (parent || wrap).appendChild(e);
  scroll();
}

/** Rebuilds the transcript view from stored messages. */
export function replay(messages) {
  let steps = null;
  let turn = null;
  const groups = [];
  const endTurn = () => { turn?.finish({ replayed: true }); turn = null; steps = null; };
  for (const m of messages) {
    if (m.role === 'user') {
      endTurn();
      addUser(m.content, m.seq, null, m.images);
    } else if (m.role === 'assistant') {
      turn ||= addTurn();
      if (m.reasoning) {
        steps = null;
        turn.interrupt();
        addThinking(turn.work()).set(m.reasoning, true);
      }
      if (m.tool_calls?.length) {
        turn.interrupt();
        if (!steps) groups.push((steps = addSteps(turn.work())));
        for (const tc of m.tool_calls) {
          let args = {};
          try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* keep {} */ }
          steps.add(tc.id, tc.function.name, args);
          turn.step();
        }
      }
      if (m.content) { steps = null; turn.prose().set(m.content); }
      // Per-round usage is stored on the message now, so a reopened chat still
      // shows what each round cost and how much of it came back from cache.
      if (m.usage) turn.usage(m.usage);
    } else if (m.role === 'tool' && steps) {
      steps.finish(m.tool_call_id, m.content, m.compacted);
    }
  }
  endTurn();
  for (const g of groups) g.quiet();
  scroll();
}
