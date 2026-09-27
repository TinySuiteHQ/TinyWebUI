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
let statistics = null;
let selectedModel = '';

const fmt = (n) => n.toLocaleString();

// Assigned the first time each model name is seen and kept for the rest of
// the session, so a model's color stays the same whether you're looking at
// "all time" or drilled into a single day -- switching levels would
// otherwise reshuffle which color means which model.
const MODEL_PALETTE = ['--accent', '--tool', '--err', '--muted', '--faint'];
const modelColors = new Map();
function colorForModel(model) {
  if (!modelColors.has(model)) modelColors.set(model, MODEL_PALETTE[modelColors.size % MODEL_PALETTE.length]);
  return `var(${modelColors.get(model)})`;
}

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
  renderCostStatistics(statistics);
  renderModelFilter();
  if (!days.length) renderDistribution([]);
  if (!days.length) {
    $('usageStats').innerHTML = '<div class="empty">no usage recorded yet</div>';
    $('usageModels').innerHTML = '';
    $('usageBars').innerHTML = '';
    $('usageRange').textContent = '';
    return;
  }

  const level = path.length === 0 ? 'year' : path.length === 1 ? 'month' : 'day';
  const scoped = (path.length === 0 ? days : days.filter((d) => d.day.startsWith(path[path.length - 1])))
    .map((d) => {
      const models = d.models.filter((m) => !selectedModel || m.model === selectedModel);
      return { ...d, models, in: models.reduce((n,m) => n + m.in, 0), out: models.reduce((n,m) => n + m.out, 0) };
    });
  renderDistribution(scoped);

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
    tile('cached', fmt(totalCached))
  );

  // Per-model breakdown, as its own list rather than crammed into a stat
  // tile: a model name plus three counts doesn't fit next to "584,746" at
  // the same width, and comma-joining every model into one string just wraps
  // wherever it wraps, with no way to see a single model's in/out split.
  const modelsBox = $('usageModels');
  modelsBox.innerHTML = '';
  if (models.length) {
    // `cached` is a subset of `in` (a cache hit still counts as an input
    // token), not a third bucket alongside it -- the API reports it that way
    // too. So each bar is fresh-in + cached-in + out, in that stacking order.
    // The bar itself is always full width: how one model's total compares to
    // another's is already in the numbers (and in the totals below), and
    // scaling bar length to that on top just makes small models unreadably
    // thin. What the bar is for here is one model's own in/cached/out split.
    for (const m of models) {
      const row = el('div', 'usage-model-row');
      const name = el('span', 'usage-model-name');
      name.textContent = m.model;
      name.title = m.model;
      const total = m.in + m.out;
      const cachedIn = Math.min(m.cached, m.in);
      const freshIn = m.in - cachedIn;
      const track = el('span', 'usage-model-track');
      const bar = el('span', 'usage-model-bar');
      for (const [cls, count] of [['fresh', freshIn], ['cached', cachedIn], ['out', m.out]]) {
        if (!count) continue;
        const seg = el('span', `usage-model-seg ${cls}`);
        seg.style.width = `${(count / total) * 100}%`;
        bar.appendChild(seg);
      }
      track.appendChild(bar);
      const counts = el('span', 'usage-model-counts');
      counts.textContent = `${fmt(m.in)} in · ${fmt(m.out)} out${m.cached ? ` · ${fmt(m.cached)} cached` : ''}`;
      row.append(name, track, counts);
      modelsBox.appendChild(row);
    }
    const legend = el('div', 'usage-model-legend');
    for (const [cls, label] of [['fresh', 'in'], ['cached', 'cached'], ['out', 'out']]) {
      const item = el('span', 'usage-model-legend-item');
      item.append(el('span', `usage-model-swatch ${cls}`), document.createTextNode(label));
      legend.appendChild(item);
    }
    modelsBox.appendChild(legend);
  }

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

  // Bars: years, or months in a year, or individual days. This is the one
  // place bar *length* means "more tokens than that other bar" -- so this is
  // also where the per-model split belongs, as colored segments inside each
  // bar, rather than on the fixed-width rows above.
  const box = $('usageBars');
  box.innerHTML = '';
  const buckets = level === 'day'
    ? scoped.map((d) => ({ key: d.day, rows: [d], models: sumModels([d]), total: d.in + d.out })).sort((a, b) => a.key.localeCompare(b.key))
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
    for (const m of b.models) {
      if (!m.in && !m.out) continue;
      const seg = el('span', 'usage-bar-seg');
      seg.style.width = `${((m.in + m.out) / b.total) * 100}%`;
      seg.style.background = colorForModel(m.model);
      fill.appendChild(seg);
    }
    track.appendChild(fill);
    const count = el('span', 'usage-bar-count');
    count.textContent = fmt(b.total);
    row.append(label, track, count);
    if (path.length < 3) {
      row.classList.add('clickable');
      row.onclick = () => { path = [...path, b.key]; render(); };
    }
    box.appendChild(row);
  }
  if (models.length > 1) {
    const legend = el('div', 'usage-model-legend');
    for (const m of models) {
      const item = el('span', 'usage-model-legend-item');
      const swatch = el('span', 'usage-model-swatch');
      swatch.style.background = colorForModel(m.model);
      item.append(swatch, document.createTextNode(m.model));
      legend.appendChild(item);
    }
    box.appendChild(legend);
  }
}

const costFmt = (value) => value == null ? 'not reported' : `$${Number(value).toFixed(6)}`;

function renderCostStatistics(stats) {
  const summary = $('statisticsSummary');
  const coverage = $('statisticsCoverage');
  const modelsBox = $('statisticsCosts');
  const toolsBox = $('statisticsTools');
  if (!summary || !coverage || !modelsBox) return;
  summary.replaceChildren(); modelsBox.replaceChildren();
  if (toolsBox) toolsBox.replaceChildren();
  if (!stats || !stats.rounds) {
    summary.appendChild(el('div', 'empty')).textContent = 'No model usage recorded yet.';
    coverage.textContent = '';
    if (toolsBox) toolsBox.appendChild(el('div', 'empty')).textContent = 'No tool calls recorded yet.';
    return;
  }
  const tile = (label, value) => {
    const box = el('div');
    const name = el('label'); name.textContent = label;
    const amount = el('div', 'usage-stat-value'); amount.textContent = value;
    box.append(name, amount); return box;
  };
  summary.append(
    tile('reported cost', costFmt(stats.reportedCost)),
    tile('average model request', costFmt(stats.averageRoundCost)),
    tile('average complete answer', costFmt(stats.averageAnswerCost)),
    tile('average answer tokens (all rounds)', stats.averageAnswerTokens == null ? '—' : Math.round(stats.averageAnswerTokens).toLocaleString()),
    tile('average rounds per answer', stats.averageRoundsPerAnswer == null ? '—' : stats.averageRoundsPerAnswer.toFixed(1))
  );
  coverage.textContent = `${stats.pricedRounds.toLocaleString()} of ${stats.rounds.toLocaleString()} model requests reported cost; `
    + `${stats.pricedAnswers.toLocaleString()} of ${stats.completedAnswers.toLocaleString()} completed answers had cost for every request. `
    + 'Answer cost includes all model requests and tool-work rounds.';
  for (const model of stats.models || []) {
    const row = el('div', 'statistics-cost-row');
    const name = el('span'); name.className = 'usage-model-name'; name.textContent = model.model; name.title = model.model;
    const amount = el('span'); amount.textContent = `${costFmt(model.cost)} · ${model.pricedRounds}/${model.rounds} priced requests`;
    row.append(name, amount); modelsBox.appendChild(row);
  }
  if (toolsBox) {
    if (!stats.tools || !stats.tools.length) {
      toolsBox.appendChild(el('div', 'empty')).textContent = 'No tool calls recorded yet.';
    } else {
      const maxCalls = Math.max(...stats.tools.map((t) => t.calls));
      for (const tool of stats.tools) {
        const row = el('div', 'statistics-tool-row');
        const name = el('span', 'statistics-tool-name'); name.textContent = tool.name; name.title = tool.name;
        const track = el('span', 'statistics-tool-track');
        const bar = el('span', 'statistics-tool-bar');
        bar.style.width = `${(tool.calls / maxCalls) * 100}%`;
        track.appendChild(bar);
        const count = el('span', 'statistics-tool-count'); count.textContent = `${tool.calls.toLocaleString()} calls`;
        row.append(name, track, count); toolsBox.appendChild(row);
      }
    }
  }
}

export async function loadUsage() {
  const response = await fetch('/api/usage');
  if (!response.ok) return;
  const data = await response.json();
  days = data.days || [];
  statistics = data.statistics || null;
  path = [];
  if (!days.some((d) => d.models.some((m) => m.model === selectedModel))) selectedModel = '';
  render();
}


const CATEGORY_LABELS = {
  operator: 'Operator / system prompt', harness: 'TinyWebUI harness', mcp_instructions: 'MCP guidance',
  tool_schemas: 'Tool schemas', user_messages: 'User messages (including document notes)',
  assistant_history: 'Assistant history', tool_history: 'Tool-call history', tool_results: 'Tool results',
  reasoning_history: 'Reasoning resent on wire', image_allowance: 'Image allowance', attachments_other: 'Other attachments',
  system_other: 'Other system content', reasoning: 'Reasoning / thinking', tool_generation: 'Tool-call generation',
  intermediate_text: 'Intermediate assistant text', final_text: 'Final visible answer', provider_delta: 'Other / provider delta'
};
function renderModelFilter() {
  const box = $('usageModelFilter');
  if (!box) return;
  box.replaceChildren();
  const label = el('label'); label.textContent = 'Token breakdown model ';
  const select = el('select'); select.setAttribute('aria-label', 'Token breakdown model');
  for (const model of ['', ...new Set(days.flatMap((d) => d.models.map((m) => m.model)))]) {
    const option = el('option'); option.value = model; option.textContent = model || 'All models';
    select.append(option);
  }
  select.value = selectedModel;
  select.onchange = () => { selectedModel = select.value; render(); };
  label.append(select); box.append(label);
}
function renderDistribution(rows) {
  const box = $('usageDistribution');
  if (!box) return;
  box.replaceChildren();
  const models = rows.flatMap((d) => d.models);
  const snapshots = models.map((m) => m.attribution).filter(Boolean);
  const requests = snapshots.reduce((n, s) => n + s.requests, 0);
  const note = el('p', 'usage-attribution-note');
  note.textContent = requests
    ? `${fmt(requests)} of ${fmt(models.reduce((n,m) => n + (m.requests || 0), 0))} requests have saved attribution. Provider totals are authoritative; ~ component counts are character-based estimates. Cache reads are a subset of input and cannot be assigned to individual components.`
    : 'No saved token attribution in this range. New requests will record it; historical prompts are not reconstructed.';
  box.append(note);
  if (!requests) return;
  for (const side of ['input', 'output']) {
    const panel = el('section', 'usage-composition');
    const heading = el('h3'); heading.textContent = side === 'input' ? 'Input composition' : 'Output composition'; panel.append(heading);
    const buckets = new Map();
    let total = 0, reported = 0;
    for (const snapshot of snapshots) {
      total += snapshot[side].total; reported += snapshot[side].reported;
      for (const b of snapshot[side].buckets) {
        const key = JSON.stringify([b.category, b.source]);
        const item = buckets.get(key) || { category: b.category, source: b.source, tokens: 0 };
        item.tokens += b.tokens; buckets.set(key, item);
      }
    }
    const complete = reported === requests;
    const summary = el('p', 'usage-attribution-note');
    summary.textContent = `${fmt(total)} provider-reported tokens across ${fmt(reported)}/${fmt(requests)} requests.`;
    if (side === 'input') summary.textContent += ` ${fmt(snapshots.reduce((n,s) => n + s.cached, 0))} cached input tokens reported.`;
    panel.append(summary);
    const table = el('table', 'usage-composition-table');
    for (const b of buckets.values()) {
      const row = el('tr');
      const label = el('td'); label.textContent = CATEGORY_LABELS[b.category] || b.category;
      const value = el('td'); value.textContent = `${b.source === 'provider' ? '' : '~'}${fmt(b.tokens)} (${b.source === 'provider' ? 'provider' : 'estimated'})`;
      const share = el('td'); share.textContent = complete && total > 0 ? `${(b.tokens / total * 100).toFixed(1)}%` : '—';
      row.append(label, value, share); table.append(row);
    }
    // A signed provider delta is intentionally not hidden or scaled away. A
    // negative delta means the estimates exceed the provider's token total.
    const hasNegative = [...buckets.values()].some((b) => b.tokens < 0);
    if (complete && total > 0 && !hasNegative) {
      const track = el('div', 'usage-composition-track');
      let i = 0;
      for (const b of buckets.values()) {
        if (!b.tokens) continue;
        const seg = el('span'); seg.style.width = `${b.tokens / total * 100}%`;
        seg.style.background = `var(${MODEL_PALETTE[i++ % MODEL_PALETTE.length]})`;
        seg.title = `${CATEGORY_LABELS[b.category] || b.category}: ${fmt(b.tokens)}`;
        track.append(seg);
      }
      panel.append(track);
    }
    panel.append(table);
    if (hasNegative) {
      const warning = el('p', 'usage-attribution-note'); warning.textContent = 'Estimates exceed provider totals in some categories. The signed delta shows the difference; components have not been rescaled.'; panel.append(warning);
    }
    box.append(panel);
  }
  const detail = el('details'); const title = el('summary'); title.textContent = 'Tool / MCP overhead by server'; detail.append(title);
  const grouped = new Map();
  for (const snapshot of snapshots) for (const b of snapshot.input.buckets) {
    if (!b.capability) continue;
    const key = `${b.capability} · ${CATEGORY_LABELS[b.category] || b.category}`;
    grouped.set(key, (grouped.get(key) || 0) + b.tokens);
  }
  for (const [label, count] of grouped) {
    const row = el('p', 'usage-attribution-note'); row.textContent = `${label}: ~${fmt(count)} estimated tokens`; detail.append(row);
  }
  box.append(detail);
}
