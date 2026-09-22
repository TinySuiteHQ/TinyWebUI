/**
 * The conversation minimap: one flat tick per question, vertically centered
 * on the right edge -- ChatGPT-nav style. At rest it's just marks; hovering
 * (or focusing) a tick reveals that question's text and clicking it jumps
 * the transcript there.
 */
import { $, el } from './dom.js';

let items = []; // { target: Element, text: string }

export function resetOutline() {
  items = [];
  render();
}

/** Called once per user turn as it's added to the transcript. */
export function addQuestion(target, text) {
  items.push({ target, text: text || '(attached document)' });
  render();
}

function render() {
  const box = $('chatOutline');
  box.innerHTML = '';
  box.hidden = items.length === 0;
  if (!items.length) return;

  for (const it of items) {
    const btn = el('button', 'outline-tick');
    btn.type = 'button';
    btn.setAttribute('aria-label', it.text);
    const bar = el('span', 'bar');
    const tip = el('span', 'tip');
    tip.textContent = it.text.replace(/\s+/g, ' ').trim();
    btn.append(tip, bar);
    btn.onclick = () => it.target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    box.appendChild(btn);
  }
}
