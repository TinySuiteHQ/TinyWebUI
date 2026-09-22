import { renderMarkdown } from './md.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls) => { const n = document.createElement(tag); if (cls) n.className = cls; return n; };
const num = (v) => (v.trim() === '' ? null : Number(v));

const log = $('log');
const wrap = $('wrap');

let chat = null;   // { id, title, messages }
let busy = false;

/* ---------- sidebar width ---------- */

/**
 * A draggable sidebar, remembered per browser.
 *
 * The width lives in a CSS variable rather than an inline style so the
 * stylesheet keeps ownership of the default: clearing the variable is what
 * resets it, and nothing here needs to know what 15rem is.
 */
const SIDE_KEY = 'tinywebui.sideWidth';
const SIDE_MIN = 176;
const SIDE_MAX = 560;

function setSideWidth(px) {
  const clamped = Math.round(Math.min(SIDE_MAX, Math.max(SIDE_MIN, px)));
  document.documentElement.style.setProperty('--side-w', `${clamped}px`);
  // Per-viewer convenience only, and blocked or full storage must not take the
  // sidebar with it.
  try { localStorage.setItem(SIDE_KEY, String(clamped)); } catch { /* not important enough to fail over */ }
  return clamped;
}

function resetSideWidth() {
  document.documentElement.style.removeProperty('--side-w');
  try { localStorage.removeItem(SIDE_KEY); } catch { /* as above */ }
}

(function initSideResize() {
  const side = $('side');
  const grip = $('side-resize');
  if (!side || !grip) return;

  try {
    const saved = Number(localStorage.getItem(SIDE_KEY));
    if (Number.isFinite(saved) && saved > 0) setSideWidth(saved);
  } catch { /* first run, or storage is unavailable; the stylesheet decides */ }

  grip.addEventListener('pointerdown', (e) => {
    // Pointer capture keeps the drag alive over the transcript, an iframe or
    // off the window edge, which a plain mousemove listener would lose.
    grip.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
    const startX = e.clientX;
    const startW = side.getBoundingClientRect().width;

    const move = (ev) => setSideWidth(startW + (ev.clientX - startX));
    const done = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', done);
      grip.removeEventListener('pointercancel', done);
      document.body.classList.remove('resizing');
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', done);
    grip.addEventListener('pointercancel', done);
    e.preventDefault();
  });

  grip.addEventListener('dblclick', resetSideWidth);

  // A drag is not reachable without a pointer, so the separator is operable
  // from the keyboard too, which is also what its role promises.
  grip.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 48 : 16;
    if (e.key === 'ArrowLeft') setSideWidth(side.getBoundingClientRect().width - step);
    else if (e.key === 'ArrowRight') setSideWidth(side.getBoundingClientRect().width + step);
    else if (e.key === 'Home' || e.key === 'Escape') resetSideWidth();
    else return;
    e.preventDefault();
  });
}());

/* ---------- history: server-side, newest first ---------- */

const KEY = 'tinywebui.chats';

let chats = [];

function renderChatList() {
  $('chats').innerHTML = '';
  if (!chats.length) {
    const e = el('div', 'empty');
    e.textContent = 'no saved chats';
    return $('chats').appendChild(e);
  }
  for (const c of chats) {
    const row = el('div', 'chat-item' + (chat && c.id === chat.id ? ' active' : ''));
    // A div with an onclick is unreachable without a mouse, so the row carries
    // the button contract explicitly: focusable, named, and activated by key.
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    if (chat && c.id === chat.id) row.setAttribute('aria-current', 'true');
    const t = el('span', 't');
    t.textContent = c.title;
    // A turn is the server's, not this tab's, so a chat can be working while
    // nothing is watching it -- including a chat opened in another window.
    if (c.running) {
      const dot = el('span', 'dot');
      dot.title = 'working';
      dot.setAttribute('aria-label', 'working');
      row.appendChild(dot);
    }
    const x = el('button', 'x');
    x.textContent = '×';
    x.title = `Delete "${c.title}"`;
    x.setAttribute('aria-label', `Delete "${c.title}"`);
    x.onclick = async (e) => {
      e.stopPropagation();
      await fetch(`/api/chats/${c.id}`, { method: 'DELETE' });
      await loadChats();
      if (chat && chat.id === c.id) newChat();
    };
    row.prepend(t);
    row.append(x);
    row.onclick = () => openChat(c.id);
    row.onkeydown = (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault(); // space would scroll the list instead
      openChat(c.id);
    };
    $('chats').appendChild(row);
  }
}

async function loadChats() {
  try {
    const res = await (await fetch('/api/chats')).json();
    chats = res.chats || [];
  } catch { chats = []; }
  // A background poll (the running-dot refresh) must not clobber search
  // results the user is looking at with the plain chronological list.
  refreshSidebar();
}

/* ---------- search ---------- */

let searchQuery = '';
let searchResults = null;
let searchSeq = 0;

/** Redraws whichever view is current -- search results, or the plain list. */
function refreshSidebar() {
  if (searchQuery && searchResults) renderSearchResults(searchResults, searchQuery);
  else renderChatList();
}

async function runSearch(q) {
  const seq = ++searchSeq;
  if (!q.trim()) {
    searchQuery = '';
    searchResults = null;
    return renderChatList();
  }
  let results = [];
  try {
    results = (await (await fetch(`/api/search?q=${encodeURIComponent(q)}`)).json()).results || [];
  } catch { /* leave whatever is on screen; the next keystroke will retry */ }
  if (seq !== searchSeq) return; // a newer query landed first -- this one is stale
  searchQuery = q;
  searchResults = results;
  renderSearchResults(results, q);
}

/** Turns snippet()'s ‹...› markers into <mark>, escaping everything else. */
function markSnippet(raw) {
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return raw.split('‹').map((chunk, i) => {
    if (i === 0) return esc(chunk);
    const at = chunk.indexOf('›');
    if (at === -1) return esc(chunk); // an unmatched marker -- show it plainly rather than eat it
    return `<mark>${esc(chunk.slice(0, at))}</mark>${esc(chunk.slice(at + 1))}`;
  }).join('');
}

const SEARCH_ROLE_LABEL = { user: 'you', assistant: 'assistant', tool: 'tool' };

function renderSearchResults(results, query) {
  $('chats').innerHTML = '';
  if (!results.length) {
    const e = el('div', 'empty');
    e.textContent = `no matches for “${query}”`;
    return $('chats').appendChild(e);
  }
  for (const r of results) {
    const row = el('div', 'chat-item search-hit');
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    const body = el('div', 't');
    const title = el('div', 'hit-title');
    title.textContent = r.chatTitle;
    const role = el('span', 'hit-role');
    role.textContent = SEARCH_ROLE_LABEL[r.role] || r.role;
    title.appendChild(role);
    const snip = el('div', 'hit-snippet');
    snip.innerHTML = markSnippet(r.snippet);
    body.append(title, snip);
    row.appendChild(body);
    const go = () => openChat(r.chatId);
    row.onclick = go;
    row.onkeydown = (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      go();
    };
    $('chats').appendChild(row);
  }
}

let searchDebounce = null;
$('chatSearch').addEventListener('input', () => {
  const q = $('chatSearch').value;
  $('chatSearchClear').hidden = !q;
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => runSearch(q), 150);
});
$('chatSearch').addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('chatSearch').value) {
    e.preventDefault();
    clearSearch();
  }
});
$('chatSearchClear').onclick = () => { clearSearch(); $('chatSearch').focus(); };

function clearSearch() {
  clearTimeout(searchDebounce);
  searchSeq++; // invalidate any in-flight query so a slow reply cannot land after this
  searchQuery = '';
  searchResults = null;
  $('chatSearch').value = '';
  $('chatSearchClear').hidden = true;
  renderChatList();
}

/**
 * Carries transcripts written before the server held them. Runs once; the flag
 * stays behind so a cleared database does not silently re-import stale chats.
 */
async function migrateLocal() {
  if (localStorage.getItem(KEY + '.migrated')) return;
  let old = [];
  try { old = JSON.parse(localStorage.getItem(KEY)) || []; } catch { /* nothing to carry */ }
  localStorage.setItem(KEY + '.migrated', '1');
  if (!old.length) return;
  try {
    await fetch('/api/chats/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chats: old })
    });
  } catch { /* the transcripts stay in localStorage; nothing is lost */ }
}

function newChat() {
  chat = { id: null, title: 'New chat' };
  wrap.innerHTML = '';
  // Starting fresh is a clear signal that browsing is done; a lingering
  // search would otherwise still be sitting over the sidebar underneath it,
  // and on mobile the drawer would otherwise still be covering the composer.
  clearSearch();
  closeSideDrawer();
}

async function openChat(id) {
  const res = await fetch(`/api/chats/${id}`);
  if (!res.ok) return;
  const found = await res.json();
  chat = { id: found.id, title: found.title };
  wrap.innerHTML = '';
  // Mid-turn, the server hands back only the settled part of the transcript;
  // the rest arrives as events, exactly as it did for the tab that started it.
  replay(found.messages);
  clearSearch();
  closeSideDrawer();
  if (found.running) rejoin(id);
}

/** Follows a turn already in flight, from the top of its event buffer. */
async function rejoin(id) {
  if (busy) return;
  setBusy(true);
  try {
    const res = await fetch(`/api/chats/${id}/stream?from=0`);
    if (res.ok) await consume(res);
  } catch { /* the transcript is in the store; reopening picks it up */ }
  setBusy(false);
  loadChats();
}

/** Rebuilds the transcript view from stored messages. */
function replay(messages) {
  let steps = null;
  let turn = null;
  const groups = [];
  const endTurn = () => { turn?.finish({ replayed: true }); turn = null; steps = null; };
  for (const m of messages) {
    if (m.role === 'user') {
      endTurn();
      addUser(m.content, m.seq);
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
      if (m.usage) addUsage(tally([m.usage]), turn.meta());
    } else if (m.role === 'tool' && steps) {
      steps.finish(m.tool_call_id, m.content, m.compacted);
    }
  }
  endTurn();
  for (const g of groups) g.quiet();
  scroll();
}

/* ---------- transcript rendering ---------- */

let pinned = true;
log.addEventListener('scroll', () => {
  pinned = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
});
function scroll() { if (pinned) log.scrollTop = log.scrollHeight; }

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
function addTurn() {
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
      if (!mounted) return;
      work.classList.remove('live');
      work.open = false;
      act.textContent = 'work';
      const bits = [`${steps} step${steps === 1 ? '' : 's'}`];
      // Elapsed time is real only for a turn we watched happen.
      if (!replayed) bits.push(`${((Date.now() - started) / 1000).toFixed(1)}s`);
      tally.textContent = bits.join(' \u00b7 ');
    }
  };
}

/** The live one-liner for the work summary: which tool, on what. */
function statusOf(name, args) {
  const short = name.replace(/^[^_]+__/, '');
  const first = Object.values(args || {})[0];
  if (first == null) return short;
  const arg = String(typeof first === 'object' ? JSON.stringify(first) : first);
  return arg ? `${short} ${arg}` : short;
}

function addUser(text, seq) {
  const m = el('div', 'msg user');
  m.innerHTML = '<div class="who">you</div>';
  const b = el('div', 'body');
  b.textContent = text;
  m.appendChild(b);

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
  scroll();
}

/** Swaps a question for a textarea, in place. Escape or cancel puts it back. */
function beginEdit(msg, body, text, seq) {
  if (busy || msg.querySelector('textarea')) return;
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
  if (busy || !chat.id) return;
  const res = await fetch(`/api/chats/${chat.id}/edit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const out = await res.json().catch(() => ({ error: `${res.status}` }));
  if (!res.ok) return addError(out.error);
  // The run is already going; openChat replays the rewound transcript and
  // attaches to it, exactly as a reload mid-turn would.
  const id = chat.id;
  await openChat(id);
  return undefined;
}

function addAssistant(parent) {
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

function addThinking(parent) {
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

function addSteps(parent) {
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
function tally(raws) {
  const t = { in: 0, out: 0, cached: 0, written: 0, discount: 0, reported: false, raw: raws, provider: null };
  for (const u of raws) {
    if (u.provider) t.provider = u.provider;
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

function addUsage(u, parent) {
  const bits = [`${u.in} in`, `${u.out} out`];
  if (u.cached) {
    const pct = u.in ? Math.round((u.cached / u.in) * 100) : 0;
    bits.push(`${u.cached} cached (${pct}%)`);
  }
  if (u.written) bits.push(`${u.written} written`);
  if (u.discount) bits.push(`cache saved ${u.discount.toFixed(4)}`);
  if (!u.cached && !u.written) bits.push(u.reported ? 'no cache hit' : 'cache not reported');
  // Worth a line of its own: a round served by a different upstream has a cold
  // cache through no fault of the prefix, and that is only visible here.
  if (u.provider) bits.push(`via ${u.provider}`);
  const line = el('div', 'usage');
  line.textContent = bits.join(' / ');
  // The raw usage objects, for when a provider reports something we do not read.
  line.title = JSON.stringify(u.raw, null, 2);
  (parent || wrap).appendChild(line);
  scroll();
}

function addNotice(text, parent) {
  const n = el('div', 'notice');
  n.textContent = text;
  (parent || wrap).appendChild(n);
  scroll();
}

function addError(text, parent) {
  const e = el('div', 'err');
  e.textContent = text;
  (parent || wrap).appendChild(e);
  scroll();
}

/* ---------- config ---------- */

/**
 * The tools panel: built-ins first, then every MCP server with its own health
 * and its tools under it. Each tool and each server carries a checkbox --
 * unchecking a tool drops it from what the model is offered; unchecking a
 * server disconnects it outright, which is one fewer live connection rather
 * than just one the model is not shown.
 *
 * Rebuilt wholesale from a fresh /api/tools payload after every toggle, so the
 * panel can never drift from what the server actually did with the request.
 */
function renderToolPanel(data) {
  const box = $('tools');
  box.innerHTML = '';

  const toggleTool = async (name, disabled) => {
    const out = await (await fetch('/api/tools/toggle', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, disabled })
    })).json();
    renderToolPanel(out);
  };

  const toggleServer = async (name, disabled) => {
    const res = await fetch(`/api/mcp/servers/${encodeURIComponent(name)}/toggle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ disabled })
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) return addError(out.error || `${res.status}`);
    renderToolPanel(out);
    loadMcp(); // the raw editor's disabled: true/false has to catch up too
  };

  // A checkbox living inside a <summary> still triggers the details' native
  // open/close on click, since that is the browser's default action for the
  // element the click landed in, not a listener that stopPropagation alone
  // would beat -- so the click itself has to be stopped from ever reaching it.
  const checkbox = (checked, title, onToggle) => {
    const label = el('label', 'tgl');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = checked;
    cb.title = title;
    cb.onclick = (e) => e.stopPropagation();
    cb.onchange = () => { cb.disabled = true; onToggle(!cb.checked); };
    label.appendChild(cb);
    return label;
  };

  const toolRow = (t) => {
    const d = el('details', 'tool' + (t.disabled ? ' off' : ''));
    const sum = el('summary');
    sum.appendChild(checkbox(
      !t.disabled,
      t.disabled ? 'Disabled -- click to let the model use this tool again' : 'Click to stop offering this tool to the model',
      (disabled) => toggleTool(t.name, disabled)
    ));
    const name = el('span', 'name');
    name.textContent = t.name.replace(/^[^_]+__/, '');
    const desc = el('span', 'desc');
    desc.textContent = (t.description || '').split('\n')[0];
    sum.append(name, desc);

    const doc = el('div', 'doc');
    doc.textContent = t.description || '(no description)';
    const props = t.parameters?.properties || {};
    const required = new Set(t.parameters?.required || []);
    if (Object.keys(props).length) {
      const list = el('div', 'params');
      for (const [key, spec] of Object.entries(props)) {
        const row = el('div', 'param');
        const b = el('b');
        b.textContent = key;
        const ty = el('span', 'ty');
        ty.textContent = spec.type || (spec.anyOf ? 'any' : '?');
        const req = el('span', required.has(key) ? 'req' : 'ty');
        req.textContent = required.has(key) ? 'required' : 'optional';
        const dd = el('span', 'd');
        dd.textContent = (spec.description || '').split('\n')[0];
        row.append(b, ty, req, dd);
        list.appendChild(row);
      }
      doc.appendChild(list);
    }
    const raw = el('pre');
    raw.textContent = JSON.stringify(t.parameters ?? {}, null, 2);
    doc.appendChild(raw);

    d.append(sum, doc);
    return d;
  };

  const STATUS_LABEL = { ok: 'connected', disabled: 'disabled', error: 'failed to connect' };

  const serverGroup = (s) => {
    const grp = el('div', `tool-group server ${s.status}`);
    const h = el('div', 'tool-group-h');
    h.appendChild(checkbox(
      s.status !== 'disabled',
      s.status === 'disabled' ? 'Disabled -- click to reconnect' : 'Click to disconnect this server',
      (disabled) => toggleServer(s.name, disabled)
    ));
    const dot = el('span', 'dot');
    const name = el('span', 'name');
    name.textContent = s.name;
    const meta = el('span', 'meta');
    meta.textContent = s.status === 'ok'
      ? `${s.tools.length} tool${s.tools.length === 1 ? '' : 's'}`
      : STATUS_LABEL[s.status];
    h.append(dot, name, meta);
    grp.appendChild(h);

    if (s.status === 'error' && s.error) {
      const err = el('div', 'tool-group-err');
      err.textContent = s.error;
      grp.appendChild(err);
    }
    if (s.status === 'ok' && s.instructions) {
      const note = el('details', 'tool-group-instructions');
      const sum = el('summary');
      sum.textContent = 'instructions';
      const body = el('div', 'body');
      body.textContent = s.instructions;
      note.append(sum, body);
      grp.appendChild(note);
    }
    if (s.status === 'ok') {
      if (!s.tools.length) {
        const empty = el('div', 'empty');
        empty.textContent = 'no tools';
        grp.appendChild(empty);
      } else {
        for (const t of s.tools) grp.appendChild(toolRow(t));
      }
    }
    return grp;
  };

  const enabled = data.internal.filter((t) => !t.disabled).length
    + data.servers.reduce((n, s) => n + s.tools.filter((t) => !t.disabled).length, 0);
  const total = data.internal.length + data.servers.reduce((n, s) => n + s.tools.length, 0);
  const up = data.servers.filter((s) => s.status === 'ok').length;
  $('toolCount').textContent = total
    ? `${enabled}/${total} enabled \u00b7 ${up}/${data.servers.length} server${data.servers.length === 1 ? '' : 's'} up`
    : 'none';

  if (data.internal.length) {
    const grp = el('div', 'tool-group');
    const h = el('div', 'tool-group-h');
    h.textContent = 'built-in';
    grp.appendChild(h);
    for (const t of data.internal) grp.appendChild(toolRow(t));
    box.appendChild(grp);
  }
  for (const s of data.servers) box.appendChild(serverGroup(s));

  if (!data.internal.length && !data.servers.length) {
    box.innerHTML = '<div class="empty">no tools</div>';
  }
}

async function loadTools() {
  renderToolPanel(await (await fetch('/api/tools')).json());
}

async function loadMcp() {
  const { path, text } = await (await fetch('/api/mcp')).json();
  $('mcpText').value = text;
  $('mcpPath').textContent = path;
}

$('saveMcp').onclick = async () => {
  const btn = $('saveMcp');
  btn.disabled = true;
  btn.textContent = 'reconnecting\u2026';
  try {
    const res = await fetch('/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: $('mcpText').value })
    });
    const out = await res.json();
    if (!res.ok) {
      $('mcpMsg').textContent = out.error;
    } else {
      await loadTools();
      $('mcpMsg').textContent = out.mcpErrors?.length ? out.mcpErrors.join('; ') : 'connected';
      await loadConfig();
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'save & reconnect';
  }
};

async function loadConfig() {
  const cfg = await (await fetch('/api/config')).json();
  $('systemPrompt').value = cfg.systemPrompt;
  $('model').value = cfg.model;
  $('temperature').value = cfg.temperature ?? '';
  $('maxTokens').value = cfg.maxTokens ?? '';
  $('maxToolRounds').value = cfg.maxToolRounds;
  $('cacheTtl').value = cfg.cacheTtl ?? '5m';
  $('compactThreshold').value = cfg.compactThreshold ?? 0;
  $('keepTurns').value = cfg.keepTurns ?? 2;
  $('maxInlineChars').value = cfg.maxInlineChars ?? 0;
  const bits = [cfg.model, `${cfg.tools.length} tools`];
  if (!cfg.hasApiKey) bits.push('NO API KEY');
  if (cfg.mcpErrors?.length) bits.push(`${cfg.mcpErrors.length} mcp err`);
  $('status').textContent = bits.join(' · ');
}

$('save').onclick = async () => {
  await fetch('/api/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      systemPrompt: $('systemPrompt').value,
      model: $('model').value.trim(),
      temperature: num($('temperature').value),
      maxTokens: num($('maxTokens').value),
      maxToolRounds: Number($('maxToolRounds').value) || 12,
      cacheTtl: $('cacheTtl').value,
      compactThreshold: Number($('compactThreshold').value) || 0,
      keepTurns: Number($('keepTurns').value) || 2,
      maxInlineChars: Number($('maxInlineChars').value) || 0
    })
  });
  await loadConfig();
  $('saveMsg').textContent = 'saved';
  toggleSettings(false);
};

$('cancel').onclick = () => toggleSettings(false);

function toggleSettings(open) {
  const panel = $('settings');
  const on = open ?? !panel.classList.contains('open');
  panel.classList.toggle('open', on);
  if (on) $('saveMsg').textContent = '';
  $('toggle-settings').textContent = on ? 'close' : 'settings';
  if (!on) input.focus();
}

$('toggle-settings').onclick = () => toggleSettings();
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('settings').classList.contains('open')) toggleSettings(false);
});
$('new').onclick = newChat;

/**
 * The mobile drawer. Three ways in beyond the menu button: tapping the
 * dimmed backdrop behind it, Escape, and picking a chat (via closeSideDrawer
 * in openChat/newChat above) -- a panel with only one way to close is the
 * kind of thing that reads as broken on a phone even when it technically
 * isn't.
 */
function setSideDrawer(open) {
  $('side').classList.toggle('open', open);
  $('side-backdrop').classList.toggle('open', open);
  $('menu').setAttribute('aria-expanded', String(open));
}
const closeSideDrawer = () => setSideDrawer(false);

$('menu').onclick = () => setSideDrawer(!$('side').classList.contains('open'));
$('side-backdrop').onclick = closeSideDrawer;
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('side').classList.contains('open')) closeSideDrawer();
});

/* ---------- send ---------- */

const input = $('input');
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 190) + 'px';
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('form').requestSubmit(); }
});

/**
 * Renders one turn from a server event stream.
 *
 * Used both by the tab that sent the message and by a tab that rejoined a turn
 * already in flight -- the events are the same either way, which is what lets a
 * reload pick a run back up instead of starting over.
 */
async function consume(res) {
  let answer = null;
  let think = null;
  let steps = null;
  const turn = addTurn();

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 2);
        if (!line.startsWith('data:')) continue;
        const ev = JSON.parse(line.slice(5));

        if (ev.type === 'reasoning') {
          // A fresh thought starts the next round, so close the open tool group:
          // otherwise later calls keep landing in a box further up the page while
          // each new thought appends at the bottom, and the order comes apart.
          if (!think) { steps = null; answer = null; turn.interrupt(); }
          think ||= addThinking(turn.work());
          think.push(ev.delta);
          turn.status('thinking');
        } else if (ev.type === 'text') {
          if (think) { think.done(); think = null; }
          // Prose is written at full width as the answer-so-far. If more work
          // follows, the turn demotes it into the work and this repeats.
          steps = null;
          if (!answer) { answer = turn.prose(); turn.status('writing'); }
          answer.push(ev.delta);
        } else if (ev.type === 'tool_call') {
          if (think) { think.done(); think = null; }
          answer = null;
          turn.interrupt();
          steps ||= addSteps(turn.work());
          steps.add(ev.id, ev.name, ev.args);
          turn.step();
          turn.status(statusOf(ev.name, ev.args));
        } else if (ev.type === 'tool_result') {
          steps?.finish(ev.id, ev.result);
        } else if (ev.type === 'chat') {
          // The server owns chat ids now; a new conversation gets one here.
          const fresh = !chat.id;
          chat.id = ev.id;
          chat.title = ev.title;
          if (fresh) loadChats();
        } else if (ev.type === 'usage') {
          // One line per round, matching what a reopened transcript will show.
          addUsage(tally([ev.usage]), turn.meta());
        } else if (ev.type === 'compacted') {
          // Handled by the accompanying notice; nothing extra to draw.
        } else if (ev.type === 'done') {
          /* the server already has them */
        } else if (ev.type === 'notice') {
          think = null;
          steps = null;
          answer = null;
          turn.interrupt();
          addNotice(ev.text, turn.meta());
        } else if (ev.type === 'error') {
          addError(ev.error, turn.el);
        }
      }
    }
    if (think) think.done();
  } catch (err) {
    addError(err.message, turn.el);
  } finally {
    // Whatever prose is still standing was the answer; the work collapses
    // behind its recap. A turn that failed mid-flight gets the same treatment,
    // so the page is never left with the work stuck open.
    turn.finish();
  }
}

/** While a turn runs, send becomes stop -- the run outlives this tab either way. */
function setBusy(on) {
  busy = on;
  $('send').textContent = on ? 'stop' : 'send';
  $('send').classList.toggle('stop', on);
  if (!on) input.focus();
}

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (busy) {
    // Closing the tab no longer stops a turn, so there has to be a way to
    // actually mean it.
    if (chat.id) await fetch(`/api/chats/${chat.id}/stop`, { method: 'POST' });
    return;
  }
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  input.style.height = 'auto';
  setBusy(true);

  addUser(text);

  try {
    // Only the new turn goes up. The server replays the rest from its own copy,
    // so a page-sized tool result crosses the wire once rather than every turn.
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: chat.id, message: text })
    });
    await consume(res);
    loadChats();
  } catch (err) {
    addError(err.message);
  } finally {
    setBusy(false);
  }
});

// A run is the server's, so the dot in the sidebar can change without this tab
// doing anything at all. Poll only while there is something to watch.
setInterval(() => {
  if (busy || chats.some((c) => c.running)) loadChats();
}, 4000);

newChat();
loadConfig();
loadMcp();
loadTools();
migrateLocal().then(loadChats);
input.focus();
