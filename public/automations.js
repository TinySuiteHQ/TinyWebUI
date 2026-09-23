import { $, el } from './dom.js';
import { openChat } from './chat.js';

const panel = $('automations');
const list = $('automation-list');
const form = $('automation-create');
let snapshot = { automations: [], chats: [] };

function close() { panel.classList.remove('open'); $('toggle-automations').classList.remove('active'); }
function options(chats, selected) {
  const select = el('select'); select.name = 'chatId'; select.required = true;
  for (const chat of chats) {
    const option = el('option'); option.value = chat.id; option.textContent = chat.title || chat.id;
    option.selected = chat.id === selected; select.appendChild(option);
  }
  return select;
}

async function load() {
  const res = await fetch('/api/automations');
  if (!res.ok) return;
  snapshot = await res.json();
  const createSelect = form.elements.chatId;
  const selected = createSelect.value;
  createSelect.replaceChildren(...snapshot.chats.map((chat) => {
    const opt = el('option'); opt.value = chat.id; opt.textContent = chat.title || chat.id; return opt;
  }));
  if (snapshot.chats.some((chat) => chat.id === selected)) createSelect.value = selected;
  list.replaceChildren();
  if (!snapshot.automations.length) {
    const empty = el('p', 'empty'); empty.textContent = 'No automations yet.'; list.appendChild(empty); return;
  }
  for (const automation of snapshot.automations) list.appendChild(await card(automation));
}

async function card(automation) {
  const article = el('article', 'automation-card');
  const heading = el('div', 'automation-card-head');
  const title = el('h3'); title.textContent = automation.name;
  const state = el('span', 'automation-state'); state.textContent = automation.enabled ? 'enabled' : 'paused';
  const trigger = el('button'); trigger.type = 'button'; trigger.textContent = 'run now';
  trigger.title = 'Run this workflow immediately';
  trigger.onclick = async () => {
    trigger.disabled = true;
    try {
      const result = await fetch(`/api/automations/${encodeURIComponent(automation.id)}/trigger`, { method:'POST' });
      const out = await result.json().catch(() => ({}));
      if (!result.ok) { trigger.disabled = false; trigger.textContent = out.error || 'run failed'; return; }
      close();
      await openChat(automation.chatId);
    } catch {
      trigger.disabled = false; trigger.textContent = 'try again';
    }
  };
  const jump = el('button'); jump.type = 'button'; jump.textContent = `open ${automation.chatTitle || 'chat'}`;
  jump.onclick = () => { close(); openChat(automation.chatId); };
  heading.append(title, state, trigger, jump); article.appendChild(heading);
  const meta = el('p', 'automation-meta');
  meta.textContent = `${automation.cron} · ${automation.timezone} · next ${automation.nextRunAt ? new Date(automation.nextRunAt).toLocaleString() : 'not scheduled'} · last ${automation.lastStatus || 'never run'}`;
  article.appendChild(meta);
  const editor = el('form', 'automation-editor');
  const name = el('input'); name.name = 'name'; name.required = true; name.maxLength = 120; name.value = automation.name;
  const cron = el('input'); cron.name = 'cron'; cron.required = true; cron.value = automation.cron;
  const timezone = el('input'); timezone.name = 'timezone'; timezone.required = true; timezone.value = automation.timezone;
  const prompt = el('textarea'); prompt.name = 'prompt'; prompt.required = true; prompt.maxLength = 12000; prompt.rows = 4; prompt.value = automation.prompt;
  const enabledLabel = el('label', 'automation-enabled');
  const enabled = el('input'); enabled.type = 'checkbox'; enabled.name = 'enabled'; enabled.checked = automation.enabled;
  enabledLabel.append(enabled, document.createTextNode(' enabled'));
  const error = el('div', 'automation-error'); error.setAttribute('role','alert');
  const save = el('button'); save.type = 'submit'; save.className = 'primary'; save.textContent = 'save changes';
  const remove = el('button'); remove.type = 'button'; remove.className = 'danger'; remove.textContent = 'delete';
  const chatSelect = options(snapshot.chats, automation.chatId);
  const labelField = (label, input) => { const labelEl = el('label'); labelEl.append(document.createTextNode(label), input); return labelEl; };
  editor.append(labelField('name',name),labelField('target chat',chatSelect),labelField('schedule (five-field cron)',cron),labelField('timezone (IANA)',timezone),labelField('instructions',prompt),enabledLabel,error,save,remove);
  editor.onsubmit = async (event) => {
    event.preventDefault(); error.textContent = '';
    const result = await fetch(`/api/automations/${encodeURIComponent(automation.id)}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name:name.value,chatId:chatSelect.value,cron:cron.value,timezone:timezone.value,prompt:prompt.value,enabled:enabled.checked })
    });
    const out = await result.json().catch(() => ({}));
    if (!result.ok) { error.textContent = out.error || 'Could not save automation.'; return; }
    await load();
  };
  remove.onclick = async () => {
    if (!confirm(`Delete “${automation.name}”?`)) return;
    const result = await fetch(`/api/automations/${encodeURIComponent(automation.id)}`, { method:'DELETE' });
    if (result.ok) await load(); else error.textContent = 'Could not delete automation.';
  };
  article.appendChild(editor);
  const history = await fetch(`/api/automations/${encodeURIComponent(automation.id)}/runs`);
  if (history.ok) {
    const { runs = [] } = await history.json();
    if (runs.length) {
      const details = el('details','automation-history');
      const summary = el('summary'); summary.textContent = `run history (${runs.length})`;
      details.appendChild(summary);
      for (const run of runs) {
        const row = el('p'); row.textContent = `${run.status} · ${run.trigger_type === 'manual' ? 'manual' : 'scheduled'} · ${new Date(run.scheduled_at).toLocaleString()}${run.error ? ` · ${run.error}` : ''}`;
        details.appendChild(row);
      }
      article.appendChild(details);
    }
  }
  return article;
}

form.onsubmit = async (event) => {
  event.preventDefault();
  const error = form.querySelector('.automation-error'); error.textContent = '';
  const data = Object.fromEntries(new FormData(form));
  const result = await fetch('/api/automations', {
    method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(data)
  });
  const out = await result.json().catch(() => ({}));
  if (!result.ok) { error.textContent = out.error || 'Could not create automation.'; return; }
  form.reset(); await load();
};

export async function openAutomations() {
  panel.classList.add('open');
  await load();
}

$('close-automations').onclick = close;
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });
setInterval(() => { if (panel.classList.contains('open')) load(); }, 30000);
