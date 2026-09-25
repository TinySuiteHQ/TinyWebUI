/**
 * Messages sent while a turn is still running. Steering lands at the next
 * safe point inside the run; a follow-up starts its own turn once the run is
 * done. The server owns the queue -- this draws it, from whatever list the
 * latest `queue` event or chat load carried.
 */
import { $, el } from './dom.js';
import { state } from './state.js';
import { addError } from './transcript.js';

const box = $('queue');

const newId = () => crypto.randomUUID?.()
  ?? [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');

export function renderQueue(items = []) {
  state.queue = items;
  box.innerHTML = '';
  box.hidden = !items.length;
  for (const item of items) {
    const chip = el('div', `queued ${item.kind}`);
    const kind = el('span', 'queued-kind');
    kind.textContent = item.kind === 'steer' ? 'next step' : 'after this';
    kind.title = item.kind === 'steer'
      ? 'Delivered as soon as the current tool calls finish'
      : 'Sent as a new message once this turn is done';
    const text = el('span', 'queued-text');
    text.textContent = item.content;
    const drop = el('button', 'queued-drop');
    drop.type = 'button';
    drop.setAttribute('aria-label', 'Remove queued message');
    drop.textContent = '×';
    drop.onclick = async () => {
      drop.disabled = true;
      // 409: already delivered -- the transcript shows it, and the next
      // queue event redraws this list either way.
      await fetch(`/api/chats/${state.chat.id}/queue/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
    };
    chip.append(kind, text, drop);
    box.appendChild(chip);
  }
}

/** Queues `text` on the running turn. False when there is no run to take it. */
export async function enqueue(kind, text) {
  const res = await fetch(`/api/chats/${state.chat.id}/queue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: newId(), kind, message: text })
  });
  const out = await res.json().catch(() => ({}));
  if (res.status === 409) return false;
  if (!res.ok) { addError(out.error || `${res.status}`); return true; }
  renderQueue(out.items);
  return true;
}

/**
 * A run that was stopped (or failed, or a server that restarted) delivers
 * nothing it had queued. Rather than send it anyway or drop it, it goes back
 * into the composer, to be sent or edited by hand.
 */
export async function reclaimQueue() {
  const items = state.queue;
  if (!items.length || !state.chat.id) return;
  const input = $('input');
  input.value = [...items.map((i) => i.content), input.value].filter(Boolean).join('\n\n');
  input.dispatchEvent(new Event('input'));
  renderQueue([]);
  await Promise.all(items.map((i) =>
    fetch(`/api/chats/${state.chat.id}/queue/${encodeURIComponent(i.id)}`, { method: 'DELETE' }).catch(() => {})));
}
