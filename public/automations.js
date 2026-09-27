import { $, el } from './dom.js';
import { openChat } from './chat.js';
import { renderMarkdown } from './md.js';
import { loadChats } from './sidebar.js';

const panel = $('automations');
const list = $('automation-list');
const createSlot = $('automation-create-slot');
let snapshot = { automations: [], chats: [] };
let automationLoadRequest = 0;

function close() { panel.classList.remove('open'); $('toggle-automations').classList.remove('active'); }

/* ---------- schedule helpers ---------- */

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEK = [1, 2, 3, 4, 5, 6, 0]; // Monday-first, the way the chips read
const pad = (n) => String(n).padStart(2, '0');
const isInt = (v) => /^\d+$/.test(v);

function parseDays(dow) {
  if (dow === '1-5') return [1, 2, 3, 4, 5];
  if (/^[0-6](,[0-6])*$/.test(dow)) return [...new Set(dow.split(',').map(Number))];
  return null;
}

/**
 * Reads a cron back into the preset it came from, so the editor can show
 * "Weekdays at 09:00" instead of five opaque fields. Anything else is custom.
 */
function parseCron(cron) {
  const f = String(cron || '').trim().split(/\s+/);
  if (f.length !== 5) return { preset: 'custom' };
  const [m, h, dom, mon, dow] = f;
  if (!isInt(m)) return { preset: 'custom' };
  if (h === '*' && dom === '*' && mon === '*' && dow === '*') return { preset: 'hourly', minute: +m };
  if (!isInt(h) || mon !== '*') return { preset: 'custom' };
  const time = `${pad(h)}:${pad(m)}`;
  if (dom === '*' && dow === '*') return { preset: 'daily', time };
  const days = dom === '*' ? parseDays(dow) : null;
  if (days) return { preset: 'days', time, days };
  if (isInt(dom) && dow === '*') return { preset: 'monthly', time, dom: +dom };
  return { preset: 'custom' };
}

function buildCron({ preset, time = '09:00', days = [1, 2, 3, 4, 5], dom = 1, minute = 0 }) {
  const [h, m] = time.split(':').map(Number);
  switch (preset) {
    case 'hourly': return `${minute} * * * *`;
    case 'daily': return `${m} ${h} * * *`;
    case 'days': {
      const sorted = [...days].sort((a, b) => a - b);
      if (sorted.length === 7) return `${m} ${h} * * *`;
      const dow = sorted.join(',') === '1,2,3,4,5' ? '1-5' : sorted.join(',');
      return `${m} ${h} * * ${dow}`;
    }
    case 'monthly': return `${m} ${h} ${dom} * *`;
    default: return null;
  }
}

function describeDays(days) {
  const key = [...days].sort((a, b) => a - b).join(',');
  if (key === '1,2,3,4,5') return 'Weekdays';
  if (key === '0,6') return 'Weekends';
  if (days.length === 1) return `Every ${DAYS[days[0]]}`;
  return WEEK.filter((d) => days.includes(d)).map((d) => DAYS[d].slice(0, 3)).join(', ');
}

function describeCron(cron) {
  const p = parseCron(cron);
  switch (p.preset) {
    case 'hourly': return `Every hour at :${pad(p.minute)}`;
    case 'daily': return `Every day at ${p.time}`;
    case 'days': return `${describeDays(p.days)} at ${p.time}`;
    case 'monthly': return `Monthly on day ${p.dom} at ${p.time}`;
    default: return `Cron ${cron}`;
  }
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
function relative(iso) {
  if (!iso) return null;
  const diff = (new Date(iso).getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  const [value, unit] = abs < 60 ? [diff, 'second'] : abs < 3600 ? [diff / 60, 'minute']
    : abs < 86400 ? [diff / 3600, 'hour'] : [diff / 86400, 'day'];
  return rtf.format(Math.round(value), unit);
}
const absolute = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

let zones;
function timezoneList() {
  if (!zones) {
    zones = el('datalist'); zones.id = 'automation-zones';
    const names = Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : [];
    for (const z of names) { const o = el('option'); o.value = z; zones.appendChild(o); }
    document.body.appendChild(zones);
  }
  return zones.id;
}
const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/* ---------- create / edit form (inline) ---------- */

function field(label, control) {
  const wrap = el('label', 'automation-field');
  const text = el('span', 'automation-label'); text.textContent = label;
  wrap.append(text, control);
  return wrap;
}

// Which form is open: 'new', an automation id, or null. The 30s refresh is
// skipped while one is, so an edit in progress never gets wiped.
let openForm = null;

/** Grows a textarea to fit its content, so long instructions are all visible. */
function autosize(t) {
  t.style.height = 'auto';
  t.style.height = `${Math.max(t.scrollHeight + 2, 320)}px`;
}

/** Builds the create/edit form: `existing` is the automation, or null to create. */
function automationForm(existing) {
  const initial = existing || {};
  const form = el('form', 'automation-editor');

  const name = el('input'); name.required = true; name.maxLength = 120;
  name.placeholder = 'e.g. Morning news digest'; name.value = initial.name || '';
  const chat = el('select'); chat.required = true;
  for (const c of snapshot.chats) {
    const o = el('option'); o.value = c.id; o.textContent = c.title || c.id; chat.appendChild(o);
  }
  if (initial.chatId) chat.value = initial.chatId;
  // Last option: have the server create a fresh chat, named here.
  const NEW_CHAT = '__new__';
  const newOpt = el('option'); newOpt.value = NEW_CHAT; newOpt.textContent = '+ New chat…';
  chat.appendChild(newOpt);
  if (!snapshot.chats.length) chat.value = NEW_CHAT;
  const newChatName = el('input'); newChatName.maxLength = 120; newChatName.placeholder = 'Name for the new chat';
  const newChatField = field('New chat name', newChatName);
  const syncChat = () => {
    const on = chat.value === NEW_CHAT;
    newChatField.hidden = !on; newChatName.required = on;
    if (on && !newChatName.value) newChatName.value = name.value.trim();
  };
  chat.addEventListener('change', () => { syncChat(); if (chat.value === NEW_CHAT) newChatName.select(); });
  syncChat();

  // Schedule: a plain dropdown, the parts it needs, raw cron as the escape hatch.
  const parsed = parseCron(initial.cron || '0 9 * * 1-5');
  let presetValue = parsed.preset;
  if (presetValue === 'days') {
    const key = [...parsed.days].sort().join(',');
    presetValue = key === '1,2,3,4,5' ? 'weekdays' : parsed.days.length === 1 ? 'weekly' : 'custom';
  }
  const preset = el('select');
  for (const [v, t] of [['hourly', 'Every hour'], ['daily', 'Every day'], ['weekdays', 'Weekdays'],
    ['weekly', 'Once a week'], ['monthly', 'Once a month'], ['custom', 'Custom (cron)']]) {
    const o = el('option'); o.value = v; o.textContent = t; preset.appendChild(o);
  }
  preset.value = presetValue;
  const time = el('input'); time.type = 'time'; time.value = parsed.time || '09:00';
  const minute = el('input'); minute.type = 'number'; minute.min = 0; minute.max = 59; minute.value = parsed.minute ?? 0;
  const day = el('select');
  for (const d of WEEK) { const o = el('option'); o.value = d; o.textContent = DAYS[d]; day.appendChild(o); }
  day.value = parsed.days?.length === 1 ? parsed.days[0] : 1;
  const dom = el('input'); dom.type = 'number'; dom.min = 1; dom.max = 28; dom.value = parsed.dom ?? 1;
  const cron = el('input'); cron.required = true; cron.spellcheck = false; cron.className = 'mono';
  cron.placeholder = '0 9 * * 1-5'; cron.value = initial.cron || '0 9 * * 1-5';
  const zone = el('input'); zone.required = true; zone.spellcheck = false;
  zone.setAttribute('list', timezoneList()); zone.value = initial.timezone || localZone();

  const timeField = field('At', time);
  const minuteField = field('Minute', minute);
  const dayField = field('On', day);
  const domField = field('Day', dom);
  const cronField = field('Cron', cron);

  function sync() {
    const p = preset.value;
    if (p !== 'custom') {
      const t = time.value || '09:00';
      cron.value = p === 'weekdays' ? buildCron({ preset: 'days', time: t, days: [1, 2, 3, 4, 5] })
        : p === 'weekly' ? buildCron({ preset: 'days', time: t, days: [Number(day.value)] })
        : buildCron({ preset: p, time: t, dom: dom.value || 1, minute: minute.value || 0 });
    }
    timeField.hidden = !['daily', 'weekdays', 'weekly', 'monthly'].includes(p);
    minuteField.hidden = p !== 'hourly';
    dayField.hidden = p !== 'weekly';
    domField.hidden = p !== 'monthly';
    cronField.hidden = p !== 'custom';
  }
  for (const c of [preset, time, minute, day, dom]) c.addEventListener('input', sync);

  const prompt = el('textarea'); prompt.required = true; prompt.maxLength = 12000;
  prompt.placeholder = 'What should the assistant do each time this runs?';
  prompt.value = initial.prompt || '';
  prompt.addEventListener('input', () => autosize(prompt));

  const enabled = el('input'); enabled.type = 'checkbox'; enabled.checked = initial.enabled ?? true;
  const enabledRow = el('label', 'automation-enabled-row');
  enabledRow.append(enabled, ' Enabled');

  const top = el('div', 'automation-row');
  top.append(field('Name', name), field('Post results to', chat), newChatField);
  const when = el('div', 'automation-row');
  when.append(field('Repeats', preset), timeField, minuteField, dayField, domField, cronField, field('Timezone', zone));

  const error = el('div', 'automation-error'); error.setAttribute('role', 'alert');
  const actions = el('div', 'automation-actions');
  if (existing) {
    const del = el('button', 'danger'); del.type = 'button'; del.textContent = 'Delete';
    del.onclick = async () => {
      if (!confirm(`Delete “${existing.name}”? This can't be undone.`)) return;
      const r = await send('DELETE', url(existing));
      if (!r.ok) { error.textContent = r.error; return; }
      openForm = null; await load();
    };
    actions.appendChild(del);
  }
  actions.append(enabledRow, el('span', 'grow'));
  const cancel = el('button'); cancel.type = 'button'; cancel.textContent = 'Cancel';
  cancel.onclick = () => { openForm = null; rerender(); };
  const submitLabel = existing ? 'Save' : 'Create';
  const submit = el('button', 'primary'); submit.type = 'submit'; submit.textContent = submitLabel;
  actions.append(cancel, submit);

  form.append(top, when, field('Instructions', prompt), error, actions);
  sync();
  // Sized once it's in the document -- scrollHeight is 0 before that.
  requestAnimationFrame(() => autosize(prompt));

  form.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); form.requestSubmit(); }
    if (e.key === 'Escape') { e.stopPropagation(); cancel.click(); }
  });
  form.onsubmit = async (event) => {
    event.preventDefault();
    error.textContent = '';
    submit.disabled = true;
    const data = {
      name: name.value.trim(), cron: cron.value.trim(),
      timezone: zone.value.trim(), prompt: prompt.value, enabled: enabled.checked
    };
    if (chat.value === NEW_CHAT) data.newChatTitle = newChatName.value.trim();
    else data.chatId = chat.value;
    const r = existing ? await send('PATCH', url(existing), data) : await send('POST', '/api/automations', data);
    submit.disabled = false; submit.textContent = submitLabel;
    if (!r.ok) { error.textContent = r.error; return; }
    openForm = null; await load();
    if (data.newChatTitle) loadChats(); // the new chat belongs in the sidebar too
  };
  return form;
}

/* ---------- api ---------- */

async function send(method, path, body) {
  const res = await fetch(path, {
    method, headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const out = await res.json().catch(() => ({}));
  return res.ok ? { ok: true, out } : { ok: false, error: out.error || `request failed (${res.status})` };
}
const url = (a, suffix = '') => `/api/automations/${encodeURIComponent(a.id)}${suffix}`;

/* ---------- rendering ---------- */

const STATUS_LABEL = { completed: 'succeeded', failed: 'failed', running: 'running', queued: 'queued' };
function statusPill(status) {
  const known = STATUS_LABEL[status];
  const pill = el('span', `automation-pill ${known ? `is-${status}` : status ? 'is-failed' : 'is-never'}`);
  pill.textContent = known || (status ? status : 'never run');
  if (status && !known) pill.title = status;
  return pill;
}

function card(automation) {
  const article = el('article', `automation-card${automation.enabled ? '' : ' is-paused'}`);

  const head = el('div', 'automation-card-head');
  const titleBox = el('div', 'automation-title');
  const title = el('h3'); title.textContent = automation.name;
  const schedule = el('p', 'automation-schedule-line');
  schedule.textContent = `${describeCron(automation.cron)} · ${automation.timezone}`;
  schedule.title = `cron: ${automation.cron}`;
  titleBox.append(title, schedule);

  // The switch saves on its own: pausing shouldn't require opening the editor.
  const toggle = el('label', 'automation-switch');
  toggle.title = automation.enabled ? 'Enabled — click to pause' : 'Paused — click to enable';
  const box = el('input'); box.type = 'checkbox'; box.checked = automation.enabled;
  box.setAttribute('aria-label', `${automation.name} enabled`);
  box.onchange = async () => {
    box.disabled = true;
    const r = await send('PATCH', url(automation), { enabled: box.checked });
    if (!r.ok) { box.checked = !box.checked; alert(r.error); }
    await load();
  };
  toggle.append(box, el('span', 'switch-track'));
  head.append(titleBox, toggle);

  const facts = el('div', 'automation-facts');
  const next = el('span');
  next.textContent = automation.enabled
    ? (automation.nextRunAt ? `Next ${relative(automation.nextRunAt)}` : 'Not scheduled')
    : 'Paused';
  if (automation.nextRunAt) next.title = absolute(automation.nextRunAt);
  const last = el('span', 'automation-last');
  last.append('Last run ', statusPill(automation.lastStatus));
  if (automation.lastRunAt) {
    const when = el('span'); when.textContent = relative(automation.lastRunAt); when.title = absolute(automation.lastRunAt);
    last.append(' ', when);
  }
  const chatLink = el('button', 'link'); chatLink.type = 'button';
  chatLink.textContent = `→ ${automation.chatTitle || 'chat'}`;
  chatLink.title = 'Open the chat this automation posts to';
  chatLink.onclick = () => { close(); openChat(automation.chatId); };
  facts.append(next, last, chatLink);

  const preview = el('p', 'automation-preview'); preview.textContent = automation.prompt;
  preview.title = 'Click to show the full instructions';
  preview.onclick = () => {
    if (getSelection().toString()) return; // selecting text shouldn't toggle it
    preview.classList.toggle('expanded');
    preview.title = preview.classList.contains('expanded') ? 'Click to collapse' : 'Click to show the full instructions';
  };

  const actions = el('div', 'automation-actions');
  const run = el('button'); run.type = 'button'; run.textContent = 'Run now';
  run.onclick = async () => {
    run.disabled = true; run.textContent = 'Starting…';
    const r = await send('POST', url(automation, '/trigger'));
    if (!r.ok) { run.disabled = false; run.textContent = 'Run now'; alert(r.error); return; }
    close(); await openChat(automation.chatId);
  };
  const edit = el('button'); edit.type = 'button';
  edit.textContent = 'Edit';
  edit.onclick = () => { openForm = automation.id; rerender(); };
  actions.append(run, edit);

  const history = el('details', 'automation-history');
  const summary = el('summary'); summary.textContent = 'Run history';
  history.appendChild(summary);
  history.addEventListener('toggle', async () => {
    if (!history.open || history.dataset.loaded) return;
    history.dataset.loaded = '1';
    let runs = [];
    try {
      const res = await fetch(url(automation, '/runs'));
      if (!res.ok) throw new Error(`${res.status}`);
      ({ runs = [] } = await res.json());
    } catch (err) {
      // Let the next expand retry instead of leaving the section empty for good.
      delete history.dataset.loaded;
      const p = el('p'); p.textContent = `Couldn't load runs (${err.message}).`; history.appendChild(p);
      history.addEventListener('toggle', () => { if (!history.open) p.remove(); }, { once: true });
      return;
    }
    if (!runs.length) { const p = el('p'); p.textContent = 'No runs yet.'; history.appendChild(p); return; }
    const table = el('div', 'automation-runs');
    for (const r of runs) {
      // Each run expands to what it actually produced, rendered the way the
      // chat would show it.
      const row = el('details', 'automation-run');
      const head = el('summary');
      const when = el('span'); when.textContent = absolute(r.scheduled_at);
      const kind = el('span', 'muted'); kind.textContent = r.trigger_type === 'manual' ? 'manual' : 'scheduled';
      head.append(statusPill(r.status), when, kind);
      if (r.started_at && r.finished_at) {
        const took = el('span', 'muted'); took.textContent = `${Math.max(1, Math.round((r.finished_at - r.started_at) / 1000))}s`;
        head.appendChild(took);
      }
      row.appendChild(head);
      const body = el('div', 'automation-run-body');
      if (r.error) { const e = el('p', 'automation-run-error'); e.textContent = r.error; body.appendChild(e); }
      if (r.result) {
        const out = el('div', 'automation-run-output md'); out.innerHTML = renderMarkdown(r.result);
        body.appendChild(out);
      } else if (!r.error) {
        const p = el('p', 'muted'); p.textContent = r.status === 'running' || r.status === 'queued' ? 'Still running…' : 'No output recorded.';
        body.appendChild(p);
      }
      const open = el('button', 'link'); open.type = 'button'; open.textContent = 'Open in chat →';
      open.onclick = () => { close(); openChat(automation.chatId); };
      body.appendChild(open);
      row.appendChild(body);
      table.appendChild(row);
    }
    history.appendChild(table);
  });
  actions.append(el('span', 'grow'), history);

  article.append(head, facts);
  if (openForm === automation.id) article.appendChild(automationForm(automation));
  else article.append(preview, actions);
  return article;
}

function rerender() {
  $('new-automation').hidden = openForm === 'new';
  createSlot.replaceChildren();
  if (openForm === 'new') {
    const c = el('section', 'automation-card');
    const h = el('h3'); h.textContent = 'New automation';
    c.append(h, automationForm(null));
    createSlot.appendChild(c);
  }
  list.replaceChildren();
  if (!snapshot.automations.length) {
    if (openForm === 'new') return;
    const empty = el('div', 'automation-empty');
    const h = el('p'); h.textContent = 'No automations yet';
    const p = el('p', 'muted'); p.textContent = 'Run a prompt on a schedule and have the result posted into a chat.';
    empty.append(h, p);
    list.appendChild(empty);
    return;
  }
  for (const automation of snapshot.automations) list.appendChild(card(automation));
}

async function load() {
  const request = ++automationLoadRequest;
  let next;
  try {
    const res = await fetch('/api/automations');
    if (!res.ok) throw new Error(`${res.status}`);
    next = await res.json();
  } catch (err) {
    if (request === automationLoadRequest && panel.classList.contains('open')) {
      list.replaceChildren(Object.assign(el('div', 'automation-empty'), { textContent: `Couldn't load automations (${err.message}).` }));
    }
    return;
  }
  if (request !== automationLoadRequest) return;
  snapshot = next;
  if (openForm && openForm !== 'new' && !snapshot.automations.some((a) => a.id === openForm)) openForm = null;
  rerender();
}

export async function openAutomations() {
  panel.classList.add('open');
  await load();
}

$('new-automation').onclick = () => {
  openForm = 'new'; rerender();
  createSlot.querySelector('input')?.focus();
};
$('close-automations').onclick = close;
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });
// Refresh the relative times and statuses, but never under an open form.
setInterval(() => {
  if (panel.classList.contains('open') && !openForm) load();
}, 30000);
