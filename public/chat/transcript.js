/**
 * Rendering the transcript: turns, messages, thinking, tool steps, usage
 * lines, notices and errors -- plus replaying a stored history into the same
 * shapes a live stream would have produced.
 */
import { renderMarkdown } from '../core/md.js';
import { $, el } from '../core/dom.js';
import { state } from '../core/state.js';
import { addQuestion } from './outline.js';
import { api } from '../core/api.js';
import { tally as tallyUsage } from '../shared/usage.js';

const log = $('log');
const wrap = $('wrap');

let pinned = true;
let openChat;

/** `deps.openChat(id)` reopens the chat after an edit rewinds it. */
export function initTranscript(deps) {
  ({ openChat } = deps);
  log.addEventListener('scroll', () => {
    pinned = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  });
}

export function scroll() { if (pinned) log.scrollTop = log.scrollHeight; }
// Switching chats always lands on the newest message, regardless of whether
// the chat left open before it had been scrolled up to read older ones.
export function pinToBottom() { pinned = true; }
// Height also changes with nobody calling scroll(): images decoding after the
// last paint, the work collapsing at the end of a turn, the composer growing.
// Re-pin on any of it, or the answer's tail sits below the fold.
new ResizeObserver(() => scroll()).observe(wrap);
new ResizeObserver(() => scroll()).observe(log);

// Chrome can keep a stale scroll range for #log after a turn reshapes it (the
// work collapsing, the last markdown paint): the wheel stops short of the end
// while scrollTop can still be set past it, until a reload. Flipping overflow
// off and on for one frame makes it rebuild the range.
function resyncScroll() {
  requestAnimationFrame(() => {
    const top = log.scrollTop;
    log.style.overflowY = 'hidden';
    void log.offsetHeight;
    log.style.overflowY = '';
    log.scrollTop = top;
    scroll();
  });
}

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
      resyncScroll();
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
  if (name === 'ask_user') return 'waiting for your answer';
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
    edit.onclick = () => beginEdit(m, b, text, seq, attachments, images);

    const again = el('button', 'linkish');
    again.type = 'button';
    again.textContent = 'retry';
    again.title = 'Answer this question again from scratch';
    // Resubmitting the same text at the same point, with every artifact it
    // already had -- retry means "this question again", not "this question
    // stripped of what it was asked with".
    again.onclick = () => rewind({ seq, message: text, ...artifactPayload(attachments, images) });

    bar.append(edit, again);
    m.appendChild(bar);
  }

  wrap.appendChild(m);
  addQuestion(m, text);
  scroll();
}

/** The rewind payload for keeping every one of a message's artifacts as-is. */
function artifactPayload(attachments, images) {
  return {
    documentIds: (attachments || []).map((a) => a.id),
    images: (images || []).map((img) => ({ mime: img.mime, data: img.data ?? img.dataBase64 }))
  };
}

/**
 * Swaps a question for a textarea, in place. Escape or cancel puts it back
 * with nothing changed -- artifact removal here is local-only until save, the
 * same way the textarea's own edits are: nothing is deleted or rewound until
 * "save & resubmit" actually fires.
 */
function beginEdit(msg, body, text, seq, attachments, images) {
  if (state.busy || msg.querySelector('textarea')) return;
  const box = el('div', 'edit-box');
  const area = el('textarea');
  area.value = text;
  area.rows = Math.min(12, text.split('\n').length + 1);

  const keptDocs = new Set((attachments || []).map((a) => a.id));
  const keptImages = new Set((images || []).map((_, i) => i));

  let artifactsBox = null;
  if (attachments?.length || images?.length) {
    artifactsBox = el('div', 'edit-artifacts');
    for (const a of attachments || []) {
      const chip = el('span', 'attachment-chip removable');
      chip.textContent = a.filename;
      chip.title = 'click to drop this document from the resubmitted message';
      chip.onclick = () => {
        if (keptDocs.has(a.id)) { keptDocs.delete(a.id); chip.classList.add('removed'); }
        else { keptDocs.add(a.id); chip.classList.remove('removed'); }
      };
      artifactsBox.appendChild(chip);
    }
    (images || []).forEach((img, i) => {
      const chip = el('span', 'attachment-chip attachment-chip-image removable');
      const thumb = el('img', 'attachment-thumb');
      thumb.src = `data:${img.mime};base64,${img.data ?? img.dataBase64}`;
      thumb.alt = img.filename || 'attached image';
      chip.title = 'click to drop this image from the resubmitted message';
      chip.appendChild(thumb);
      chip.onclick = () => {
        if (keptImages.has(i)) { keptImages.delete(i); chip.classList.add('removed'); }
        else { keptImages.add(i); chip.classList.remove('removed'); }
      };
      artifactsBox.appendChild(chip);
    });
  }

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
    const docsChanged = keptDocs.size !== (attachments || []).length;
    const imagesChanged = keptImages.size !== (images || []).length;
    if (next === text && !docsChanged && !imagesChanged) return close();
    return rewind({
      seq,
      message: next,
      documentIds: (attachments || []).filter((a) => keptDocs.has(a.id)).map((a) => a.id),
      removeDocumentIds: (attachments || []).filter((a) => !keptDocs.has(a.id)).map((a) => a.id),
      images: (images || [])
        .filter((_, i) => keptImages.has(i))
        .map((img) => ({ mime: img.mime, data: img.data ?? img.dataBase64 }))
    });
  };
  area.onkeydown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save.onclick(); }
  };

  const row = el('div', 'edit-actions');
  row.append(save, cancel);
  if (artifactsBox) box.append(artifactsBox);
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
  try { await api.post(`/api/chats/${state.chat.id}/edit`, payload); } catch (err) { return addError(err.message); }
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
      rows.set(id, { d, ms, pre, t0: Date.now(), name, done: false });
      scroll();
    },
    finish(id, result, compacted) {
      const row = rows.get(id);
      if (!row) return;
      row.done = true;
      row.ms.textContent = `${((Date.now() - row.t0) / 1000).toFixed(1)}s`;
      if (/^Error/.test(result)) row.d.classList.add('bad');
      // The transcript always keeps the full output; compaction only shortens
      // what the model is sent, so the badge is the only visible difference.
      if (compacted) row.d.classList.add('compacted');
      row.pre.textContent += '\n\n' + result;
      scroll();
    },
    /**
     * A call held for the user's approval: the row opens with its arguments
     * showing and three buttons under them. `onDecide` sends the answer; the
     * buttons stay until the server confirms it with approval_done, so a
     * second tab watching the same run settles too.
     */
    ask(id, onDecide) {
      const row = rows.get(id);
      if (!row || row.ask) return;
      row.d.open = true;
      row.d.classList.add('waiting');
      row.ms.textContent = 'needs approval';
      const bar = el('div', 'approve');
      const button = (label, decision, cls) => {
        const b = el('button', cls);
        b.textContent = label;
        b.onclick = () => {
          for (const x of bar.querySelectorAll('button')) x.disabled = true;
          onDecide(decision).catch(() => { for (const x of bar.querySelectorAll('button')) x.disabled = false; });
        };
        return b;
      };
      bar.append(
        button('allow', 'allow', 'primary'),
        button('always allow this tool', 'always'),
        button('deny', 'deny')
      );
      row.d.appendChild(bar);
      row.ask = bar;
      scroll();
    },
    settle(id, decision) {
      const row = rows.get(id);
      if (!row?.ask) return;
      row.ask.remove();
      row.ask = null;
      row.d.classList.remove('waiting');
      row.d.open = false;
      row.ms.textContent = decision === 'deny' ? 'denied' : '…';
      row.t0 = Date.now();
    },
    /**
     * An ask_user question: the row opens on the question, with any choices,
     * a text box when free text is allowed, "continue without me", and a
     * countdown to the deadline. Like approvals, it stays until the server
     * confirms with question_done, so every tab watching the run settles.
     * `onAnswer({ answer } | { skip: true })` sends it.
     */
    question(id, q, onAnswer) {
      const row = rows.get(id);
      if (!row || row.question) return;
      row.d.open = true;
      row.d.classList.add('waiting');
      row.ms.textContent = 'waiting for you';
      const box = el('div', 'ask');
      const text = el('p', 'ask-q');
      text.textContent = q.question;
      box.appendChild(text);
      const lock = (on) => { for (const x of box.querySelectorAll('button, input')) x.disabled = on; };
      const send = (body) => { lock(true); onAnswer(body).catch(() => lock(false)); };
      if (q.choices?.length) {
        const bar = el('div', 'ask-choices');
        for (const c of q.choices) {
          const b = el('button');
          b.textContent = c;
          b.onclick = () => send({ answer: c });
          bar.appendChild(b);
        }
        box.appendChild(bar);
      }
      const foot = el('div', 'ask-foot');
      if (q.allowFreeText) {
        const form = el('form', 'ask-free');
        const input = el('input');
        input.placeholder = q.choices?.length ? 'or type an answer…' : 'your answer…';
        input.setAttribute('aria-label', 'Answer');
        const go = el('button', 'primary');
        go.type = 'submit';
        go.textContent = 'answer';
        form.append(input, go);
        form.onsubmit = (e) => {
          e.preventDefault();
          if (input.value.trim()) send({ answer: input.value.trim() });
        };
        box.appendChild(form);
        setTimeout(() => input.focus(), 0);
      }
      const skip = el('button', 'ask-skip');
      skip.textContent = 'continue without me';
      skip.onclick = () => send({ skip: true });
      const clock = el('span', 'ask-clock');
      foot.append(skip, clock);
      box.appendChild(foot);
      let tick = null;
      if (q.deadline) {
        const paint = () => {
          const left = Math.max(0, Math.ceil((q.deadline - Date.now()) / 1000));
          clock.textContent = `continues on its own in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
        };
        paint();
        tick = setInterval(paint, 1000);
      }
      row.d.appendChild(box);
      row.question = { box, tick };
      scroll();
    },
    /** The ask_user call still running here: calls are sequential, so at most one. */
    pendingAsk() {
      return [...rows.entries()].find(([, r]) => r.name === 'ask_user' && !r.done)?.[0];
    },
    settleQuestion(id, status) {
      const row = rows.get(id);
      if (!row?.question) return;
      clearInterval(row.question.tick);
      row.question.box.remove();
      row.question = null;
      row.d.classList.remove('waiting');
      row.d.open = false;
      row.ms.textContent = { answered: '…', timeout: 'no answer', skipped: 'skipped', cancelled: 'stopped' }[status] || '…';
      row.t0 = Date.now();
    },
    // Timings are meaningless on a replayed transcript.
    quiet() { for (const r of rows.values()) r.ms.textContent = ''; }
  };
}

const fmt = (n) => n.toLocaleString('en-US');

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
      // A whitespace-only content string ("\n\n") rides alongside tool_calls on
      // some backends (DeepSeek/CoreWeave). Treating it as real prose would null
      // `steps` right after creating it, so the tool result that follows never
      // gets attached to its row -- it'd render but never show what it returned.
      if (m.content?.trim()) { steps = null; turn.prose().set(m.content); }
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
