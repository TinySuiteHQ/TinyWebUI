import { renderMarkdown } from './md.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls) => { const n = document.createElement(tag); if (cls) n.className = cls; return n; };
const num = (v) => (v.trim() === '' ? null : Number(v));

const log = $('log');
const wrap = $('wrap');

let chat = null;   // { id, title, messages }
let busy = false;

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
    const t = el('span', 't');
    t.textContent = c.title;
    const x = el('button', 'x');
    x.textContent = '×';
    x.title = 'Delete';
    x.onclick = async (e) => {
      e.stopPropagation();
      await fetch(`/api/chats/${c.id}`, { method: 'DELETE' });
      await loadChats();
      if (chat && chat.id === c.id) newChat();
    };
    row.append(t, x);
    row.onclick = () => openChat(c.id);
    $('chats').appendChild(row);
  }
}

async function loadChats() {
  try {
    const res = await (await fetch('/api/chats')).json();
    chats = res.chats || [];
  } catch { chats = []; }
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
  renderChatList();
}

async function openChat(id) {
  const res = await fetch(`/api/chats/${id}`);
  if (!res.ok) return;
  const found = await res.json();
  chat = { id: found.id, title: found.title };
  wrap.innerHTML = '';
  replay(found.messages);
  renderChatList();
  $('side').classList.remove('open');
}

/** Rebuilds the transcript view from stored messages. */
function replay(messages) {
  let steps = null;
  let rail = null;
  const groups = [];
  for (const m of messages) {
    if (m.role === 'user') {
      steps = null;
      rail = null;
      addUser(m.content);
    } else if (m.role === 'assistant') {
      if (m.reasoning) {
        steps = null;
        rail ||= addRail();
        addThinking(rail).set(m.reasoning, true);
      }
      if (m.tool_calls?.length) {
        rail ||= addRail();
        if (!steps) groups.push((steps = addSteps(rail)));
        for (const tc of m.tool_calls) {
          let args = {};
          try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* keep {} */ }
          steps.add(tc.id, tc.function.name, args);
        }
      }
      if (m.content) { steps = null; rail = null; addAssistant().set(m.content); }
      // Per-round usage is stored on the message now, so a reopened chat still
      // shows what each round cost and how much of it came back from cache.
      if (m.usage) addUsage(tally([m.usage]), rail);
    } else if (m.role === 'tool' && steps) {
      steps.finish(m.tool_call_id, m.content, m.compacted);
    }
  }
  for (const g of groups) g.quiet();
  scroll();
}

/* ---------- transcript rendering ---------- */

let pinned = true;
log.addEventListener('scroll', () => {
  pinned = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
});
function scroll() { if (pinned) log.scrollTop = log.scrollHeight; }

/** Groups a round's thinking and tool calls into one indented "work" rail, so
    intermediate steps read as process rather than as answer. */
function addRail() {
  const r = el('div', 'work');
  wrap.appendChild(r);
  return r;
}

function addUser(text) {
  const m = el('div', 'msg user');
  m.innerHTML = '<div class="who">you</div>';
  const b = el('div', 'body');
  b.textContent = text;
  m.appendChild(b);
  wrap.appendChild(m);
  scroll();
}

function addAssistant() {
  const m = el('div', 'msg assistant');
  m.innerHTML = '<div class="who">assistant</div>';
  const b = el('div', 'md');
  m.appendChild(b);
  wrap.appendChild(m);
  let raw = '';
  let queued = false;
  const paint = () => { queued = false; b.innerHTML = renderMarkdown(raw); scroll(); };
  return {
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
  const t = { in: 0, out: 0, cached: 0, written: 0, discount: 0, reported: false, raw: raws };
  for (const u of raws) {
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
  const line = el('div', 'usage');
  line.textContent = bits.join(' / ');
  // The raw usage objects, for when a provider reports something we do not read.
  line.title = JSON.stringify(u.raw, null, 2);
  (parent || wrap).appendChild(line);
  scroll();
}

function addNotice(text) {
  const n = el('div', 'notice');
  n.textContent = text;
  wrap.appendChild(n);
  scroll();
}

function addError(text) {
  const e = el('div', 'err');
  e.textContent = text;
  wrap.appendChild(e);
  scroll();
}

/* ---------- config ---------- */

/** One expandable row per tool: server, name, blurb; open for the full schema. */
function showTools(tools) {
  const box = $('tools');
  box.innerHTML = '';
  $('toolCount').textContent = `${tools.length} from ${new Set(tools.map(serverOf)).size} server(s)`;
  if (!tools.length) {
    box.innerHTML = '<div class="empty">no tools</div>';
    return;
  }
  for (const t of tools) {
    const d = el('details', 'tool');
    const sum = el('summary');
    const srv = el('span', 'srv');
    srv.textContent = serverOf(t);
    const name = el('span', 'name');
    name.textContent = t.name.replace(/^[^_]+__/, '');
    const desc = el('span', 'desc');
    desc.textContent = (t.description || '').split('\n')[0];
    sum.append(srv, name, desc);

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
    box.appendChild(d);
  }
}

const serverOf = (t) => (typeof t === 'string' ? t : t.name).split('__')[0];

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
      showTools(out.tools);
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
  showTools(cfg.tools);
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
$('menu').onclick = () => $('side').classList.toggle('open');

/* ---------- send ---------- */

const input = $('input');
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 190) + 'px';
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('form').requestSubmit(); }
});

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || busy) return;
  input.value = '';
  input.style.height = 'auto';
  busy = true;
  $('send').disabled = true;

  addUser(text);

  let answer = null;
  let think = null;
  let steps = null;
  let rail = null;

  try {
    // Only the new turn goes up. The server replays the rest from its own copy,
    // so a page-sized tool result crosses the wire once rather than every turn.
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: chat.id, message: text })
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

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
          if (!think) { steps = null; answer = null; }
          rail ||= addRail();
          think ||= addThinking(rail);
          think.push(ev.delta);
        } else if (ev.type === 'text') {
          if (think) { think.done(); think = null; }
          // Prose ends the intermediate work: the answer leaves the rail and is
          // rendered at full width.
          steps = null;
          rail = null;
          answer ||= addAssistant();
          answer.push(ev.delta);
        } else if (ev.type === 'tool_call') {
          if (think) { think.done(); think = null; }
          answer = null;
          rail ||= addRail();
          steps ||= addSteps(rail);
          steps.add(ev.id, ev.name, ev.args);
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
          addUsage(tally([ev.usage]), rail);
        } else if (ev.type === 'compacted') {
          // Handled by the accompanying notice; nothing extra to draw.
        } else if (ev.type === 'done') {
          /* the server already has them */
        } else if (ev.type === 'notice') {
          think = null;
          steps = null;
          answer = null;
          rail = null;
          addNotice(ev.text);
        } else if (ev.type === 'error') {
          addError(ev.error);
        }
      }
    }
    if (think) think.done();
    loadChats();
  } catch (err) {
    addError(err.message);
  } finally {
    busy = false;
    $('send').disabled = false;
    input.focus();
  }
});

newChat();
loadConfig();
loadMcp();
migrateLocal().then(loadChats);
input.focus();
