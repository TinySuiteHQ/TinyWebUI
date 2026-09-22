/**
 * Token usage panel: LLM name, tokens in/out/cached, and a drill-down bar
 * chart -- years, click a year for its months, click a month for its days.
 * The server hands back one row per calendar day (store.usageRollup());
 * everything coarser than a day is folded client-side from that, since a
 * year of daily rows is cheap to carry but expensive to re-derive per click.
 */
import { $, el } from './dom.js';

let days = []; // raw daily rows from /api/usage
let path = []; // drill-down breadcrumb, e.g. ['2026'] or ['2026', '2026-03']

const fmt = (n) => n.toLocaleString();

function sumModels(rows) {
  const totals = new Map();
  for (const row of rows) {
    for (const m of row.models) {
      if (!totals.has(m.model)) totals.set(m.model, { model: m.model, in: 0, out: 0, cached: 0 });
      const t = totals.get(m.model);
      t.in += m.in; t.out += m.out; t.cached += m.cached;
    }
  }
  return [...totals.values()].sort((a, b) => b.in + b.out - (a.in + a.out));
}

/** Groups daily rows by year, or by month within a chosen year. */
function bucket(rows, level) {
  const groups = new Map();
  for (const row of rows) {
    const key = level === 'year' ? row.day.slice(0, 4) : row.day.slice(0, 7);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()]
    .map(([key, rows]) => {
      const models = sumModels(rows);
      const total = models.reduce((n, m) => n + m.in + m.out, 0);
      return { key, rows, models, total };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

function render() {
  if (!days.length) {
    $('usageStats').innerHTML = '<div class="empty">no usage recorded yet</div>';
    $('usageBars').innerHTML = '';
    $('usageRange').textContent = '';
    return;
  }

  const level = path.length === 0 ? 'year' : path.length === 1 ? 'month' : 'day';
  const scoped = path.length === 0
    ? days
    : days.filter((d) => d.day.startsWith(path[path.length - 1]));

  // Stat tiles: totals for whatever is currently in view.
  const models = sumModels(scoped);
  const totalIn = models.reduce((n, m) => n + m.in, 0);
  const totalOut = models.reduce((n, m) => n + m.out, 0);
  const totalCached = models.reduce((n, m) => n + m.cached, 0);

  const stats = $('usageStats');
  stats.innerHTML = '';
  const tile = (label, value) => {
    const box = el('div');
    const l = el('label');
    l.textContent = label;
    const v = el('div', 'usage-stat-value');
    v.textContent = value;
    box.append(l, v);
    return box;
  };
  stats.append(
    tile('tokens in', fmt(totalIn)),
    tile('tokens out', fmt(totalOut)),
    tile('cached', fmt(totalCached)),
    tile('by model', models.length ? models.map((m) => `${m.model} (${fmt(m.in + m.out)})`).join(', ') : '—')
  );

  // Breadcrumb.
  const crumbs = ['all time', ...path];
  $('usageRange').innerHTML = '';
  crumbs.forEach((label, i) => {
    if (i > 0) $('usageRange').appendChild(document.createTextNode(' / '));
    const a = el('a');
    a.href = '#';
    a.textContent = label;
    a.onclick = (e) => { e.preventDefault(); path = path.slice(0, i); render(); };
    $('usageRange').appendChild(a);
  });

  // Bars: years, or months in a year, or individual days.
  const box = $('usageBars');
  box.innerHTML = '';
  const buckets = level === 'day'
    ? scoped.map((d) => ({ key: d.day, rows: [d], total: d.in + d.out })).sort((a, b) => a.key.localeCompare(b.key))
    : bucket(scoped, level);
  if (!buckets.length) {
    box.innerHTML = '<div class="empty">nothing here</div>';
    return;
  }
  const max = Math.max(...buckets.map((b) => b.total), 1);
  for (const b of buckets) {
    const row = el('div', 'usage-bar-row');
    const label = el('span', 'usage-bar-label');
    label.textContent = level === 'day' ? b.key.slice(8) : (level === 'year' ? b.key : b.key.slice(5));
    const track = el('span', 'usage-bar-track');
    const fill = el('span', 'usage-bar-fill');
    fill.style.width = `${Math.max((b.total / max) * 100, 2)}%`;
    track.appendChild(fill);
    const count = el('span', 'usage-bar-count');
    count.textContent = fmt(b.total);
    row.append(label, track, count);
    if (level !== 'day') {
      row.classList.add('clickable');
      row.onclick = () => { path = [...path, b.key]; render(); };
    }
    box.appendChild(row);
  }
}

export async function loadUsage() {
  const data = await (await fetch('/api/usage')).json();
  days = data.days || [];
  path = [];
  render();
}
