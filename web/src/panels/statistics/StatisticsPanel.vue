<script setup lang="ts">
/**
 * Token usage and cost. The server hands back one row per calendar day;
 * everything coarser (years, months) is folded here, since a year of daily
 * rows is cheap to carry but expensive to re-derive per click.
 *
 * Read top-down: the totals, then usage over time (the one part that drills
 * down by period), then the breakdowns, then the diagnostics (where the
 * tokens went, why the cache missed), folded away until asked for.
 */
import { computed, ref } from 'vue';
import { api } from '../../core/api.ts';
import { PANEL } from '../../stores/panels.ts';
import { usePanel } from '../usePanel.ts';

// /api/usage is a wide report read field by field.
type Json = any;
type ModelTotal = { model: string, in: number, out: number, cached: number, requests: number };
type Day = { day: string, models: (ModelTotal & { attribution?: Json })[] };

const days = ref<Day[]>([]);
const stats = ref<Json | null>(null);
const targets = ref<Json[]>([]);
const error = ref('');
const loaded = ref(false);
// Drill-down: [] is every year, ['2026'] its months, ['2026', '2026-03'] its days.
const path = ref<string[]>([]);
// '' is everything, else JSON of { model, provider? }.
const selected = ref('');
let request = 0;

const fmt = (n: number | null | undefined) => (n == null ? '—' : Math.round(n).toLocaleString());
const pct = (share: number | null | undefined) => (share == null ? '—' : `${(share * 100).toFixed(1)}%`);
/** Money as people read it: cents once it is a dollar or more, two significant digits below that. */
function money(v: number | null | undefined) {
  if (v == null) return '—';
  if (v === 0) return '$0';
  const a = Math.abs(v);
  if (a >= 1) return `$${v.toFixed(2)}`;
  return `$${v.toFixed(Math.min(8, Math.max(2, 1 - Math.floor(Math.log10(a)))))}`;
}

// A model keeps its colour for the whole session, at every drill-down level
// and whatever the filter, in the chart palette's fixed order.
const SERIES = 8;
const colors = new Map<string, number>();
function colorFor(model: string) {
  if (!colors.has(model)) colors.set(model, colors.size % SERIES + 1);
  return `var(--chart-${colors.get(model)})`;
}

function sumModels(rows: Day[]): ModelTotal[] {
  const totals = new Map<string, ModelTotal>();
  for (const row of rows) for (const m of row.models) {
    const t = totals.get(m.model) || { model: m.model, in: 0, out: 0, cached: 0, requests: 0 };
    t.in += m.in; t.out += m.out; t.cached += m.cached; t.requests += m.requests || 0;
    totals.set(m.model, t);
  }
  return [...totals.values()].sort((a, b) => b.in + b.out - (a.in + a.out));
}
const sumTotals = (list: ModelTotal[]) => list.reduce((t, m) => ({ in: t.in + m.in, out: t.out + m.out, cached: t.cached + m.cached }), { in: 0, out: 0, cached: 0 });

/* ---------- totals (all time, for the model filter) ---------- */

const cache = computed(() => stats.value?.cache || {});
const allModels = computed(() => sumModels(days.value));
const allTotals = computed(() => sumTotals(allModels.value));
const priced = computed(() => Boolean(stats.value?.pricedRounds));

const kpis = computed(() => {
  const s = stats.value;
  if (!s?.rounds) return [];
  const t = allTotals.value;
  const c = cache.value;
  return [
    { label: 'Requests', value: fmt(s.rounds), sub: s.completedAnswers ? `${fmt(s.completedAnswers)} answers` : '' },
    { label: 'Input tokens', value: fmt(t.in), sub: t.cached ? `${fmt(t.cached)} from cache` : '' },
    { label: 'Output tokens', value: fmt(t.out), sub: '' },
    { label: 'Cache hit rate', value: pct(c.hitShare), sub: c.reportedRounds ? 'of input, where reported' : 'not reported' },
    { label: 'Cost', value: priced.value ? money(s.reportedCost) : '—',
      sub: !priced.value ? 'not reported by provider' : c.saved ? `${money(c.saved)} saved by cache` : '' }
  ];
});

// Only what is off: full coverage needs no sentence.
const coverage = computed(() => {
  const s = stats.value;
  if (!s?.rounds) return '';
  const notes: string[] = [];
  if (s.pricedRounds < s.rounds) notes.push(`${fmt(s.pricedRounds)} of ${fmt(s.rounds)} requests reported a cost`);
  if (s.pricedAnswers < s.completedAnswers) notes.push(`${fmt(s.pricedAnswers)} of ${fmt(s.completedAnswers)} answers fully priced`);
  if (!cache.value.reportedRounds) notes.push('no provider has reported cache figures yet');
  if (s.auxiliary?.requests) notes.push(`conversation summaries (${fmt(s.auxiliary.requests)} requests, ${money(s.auxiliary.cost)}) are not counted above`);
  return notes.length ? `${notes.join('; ')}.` : '';
});

/* ---------- over time (drills down by period) ---------- */

const level = computed(() => (path.value.length === 0 ? 'year' : path.value.length === 1 ? 'month' : 'day'));
const scoped = computed(() => (path.value.length ? days.value.filter((d) => d.day.startsWith(path.value[path.value.length - 1] as string)) : days.value));
const scopedTotals = computed(() => sumTotals(sumModels(scoped.value)));
const canDrill = computed(() => path.value.length < 2);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const crumbLabel = (key: string) => (key.length === 7 ? `${MONTHS[Number(key.slice(5)) - 1]} ${key.slice(0, 4)}` : key);

/** Bars: years, months in a year, or days. The one place length compares one bar with another. */
const buckets = computed(() => {
  const rows = scoped.value;
  const groups = new Map<string, Day[]>();
  for (const row of rows) {
    const key = level.value === 'year' ? row.day.slice(0, 4) : level.value === 'month' ? row.day.slice(0, 7) : row.day;
    groups.set(key, [...(groups.get(key) || []), row]);
  }
  return [...groups.entries()].map(([key, list]) => {
    const m = sumModels(list);
    const label = level.value === 'year' ? key : level.value === 'month' ? MONTHS[Number(key.slice(5)) - 1] as string : String(Number(key.slice(8)));
    const total = m.reduce((n, x) => n + x.in + x.out, 0);
    const title = [`${crumbLabel(key)}: ${fmt(total)} tokens`, ...m.map((x) => `${x.model}: ${fmt(x.in)} in, ${fmt(x.out)} out`)].join('\n');
    return { key, label, models: m, total, title };
  }).sort((a, b) => a.key.localeCompare(b.key));
});
const maxBucket = computed(() => Math.max(...buckets.value.map((b) => b.total), 1));
const rangeName = computed(() => (path.value.length ? crumbLabel(path.value[path.value.length - 1] as string) : 'all time'));

/* ---------- by model, tools, averages ---------- */

const byModel = computed(() => {
  const costs = new Map<string, Json>((stats.value?.models || []).map((m: Json) => [m.model, m]));
  return allModels.value.map((m) => {
    const c = costs.get(m.model);
    return { ...m, cost: c?.pricedRounds ? c.cost : null, partial: Boolean(c && c.pricedRounds && c.pricedRounds < c.rounds) };
  });
});
const tools = computed<Json[]>(() => stats.value?.tools || []);
const maxCalls = computed(() => Math.max(1, ...tools.value.map((t) => t.calls)));

const rates = computed(() => (cache.value.rates || []).map((r: Json) => `${r.model}${r.provider ? ` @ ${r.provider}` : ''}: `
  + `${money(r.full * 1e6)}/M full, ${money(r.cache * 1e6)}/M cached`).join('\n'));
/** Averages with a value; the coverage note says why the others are missing. */
const averages = computed(() => {
  const s = stats.value;
  if (!s?.rounds) return [];
  const c = cache.value;
  return [
    { label: 'Cost per request', value: s.averageRoundCost == null ? null : money(s.averageRoundCost), hint: '' },
    { label: 'Cost per answer', value: s.averageAnswerCost == null ? null : money(s.averageAnswerCost), hint: 'All model requests of the answer, tool rounds included.' },
    { label: 'Tokens per answer', value: s.averageAnswerTokens == null ? null : fmt(s.averageAnswerTokens), hint: 'All rounds of the answer.' },
    { label: 'Requests per answer', value: s.averageRoundsPerAnswer == null ? null : s.averageRoundsPerAnswer.toFixed(1), hint: '' },
    { label: 'Saved by cache', value: c.saved == null ? null : `${money(c.saved)}${c.savedShare == null ? '' : ` (${pct(c.savedShare)})`}`,
      hint: 'Against what these requests would have cost with no cache. Where the provider does not report it, it is worked out from the input cost it charged at different cache ratios.' + (rates.value ? `\n\n${rates.value}` : '') }
  ].filter((a) => a.value != null);
});

/* ---------- diagnostics ---------- */

// Ordered like the server's MISS: the first is the one that is ours to fix.
const MISS_LABELS = [
  ['prefix', 'Prefix changed', 'Something already sent was altered; worth investigating.'],
  ['switch', 'Provider switched', 'A different upstream served it, with its own cache.'],
  ['expired', 'Expired', 'More than 5 minutes idle since the previous request.'],
  ['stub', 'Result stubbed', 'A large tool result switched to its stub after its turn, as planned.'],
  ['provider', 'Provider-side', 'Same prefix, same upstream, in time, and it still missed.']
] as const;
const judged = computed(() => (stats.value?.rounds ? cache.value.judged || 0 : 0));
const misses = computed<Record<string, number>>(() => cache.value.misses || {});
const missTotal = computed(() => Object.values(misses.value).reduce((n, v) => n + v, 0));

const CATEGORY_LABELS: Record<string, string> = {
  operator: 'Operator / system prompt', harness: 'TinyWebUI harness', mcp_instructions: 'MCP guidance', checkpoint: 'Conversation summary',
  tool_schemas: 'Tool schemas', user_messages: 'User messages (including document notes)',
  assistant_history: 'Assistant history', tool_history: 'Tool-call history', tool_results: 'Tool results',
  reasoning_history: 'Reasoning resent on wire', image_allowance: 'Image allowance', attachments_other: 'Other attachments',
  system_other: 'Other system content', reasoning: 'Reasoning / thinking', tool_generation: 'Tool-call generation',
  intermediate_text: 'Intermediate assistant text', final_text: 'Final visible answer', provider_delta: 'Other / provider delta'
};
const label = (c: string) => CATEGORY_LABELS[c] || c;

const attribution = computed(() => {
  const all = scoped.value.flatMap((d) => d.models);
  const snapshots = all.map((m) => m.attribution).filter(Boolean);
  const requests = snapshots.reduce((n, s) => n + s.requests, 0);
  const totalRequests = all.reduce((n, m) => n + (m.requests || 0), 0);
  const sides = (['input', 'output'] as const).map((side) => {
    const buckets = new Map<string, { category: string, source: string, tokens: number }>();
    let total = 0;
    let reported = 0;
    for (const s of snapshots) {
      total += s[side].total; reported += s[side].reported;
      for (const b of s[side].buckets) {
        const key = JSON.stringify([b.category, b.source]);
        const item = buckets.get(key) || { category: b.category, source: b.source, tokens: 0 };
        item.tokens += b.tokens;
        buckets.set(key, item);
      }
    }
    const list = [...buckets.values()].sort((a, b) => b.tokens - a.tokens);
    const complete = reported === requests;
    // A signed provider delta is shown as is, never scaled away: negative
    // means the estimates exceed the provider's own total.
    const negative = list.some((b) => b.tokens < 0);
    const max = Math.max(1, ...list.map((b) => b.tokens));
    return { side, list, total, reported, complete, negative, max, cached: side === 'input' ? snapshots.reduce((n, s) => n + s.cached, 0) : 0 };
  });
  const overhead = new Map<string, number>();
  for (const s of snapshots) for (const b of s.input.buckets) {
    if (!b.capability) continue;
    const key = `${b.capability} · ${label(b.category)}`;
    overhead.set(key, (overhead.get(key) || 0) + b.tokens);
  }
  return { requests, totalRequests, sides, overhead: [...overhead.entries()].sort((a, b) => b[1] - a[1]) };
});

/* ---------- loading ---------- */

const filterOptions = computed(() => {
  const out: { value: string, text: string }[] = [{ value: '', text: 'All models' }];
  // A model served by several upstreams also gets one entry per upstream:
  // each has its own prices and its own cache.
  for (const t of targets.value) {
    out.push({ value: JSON.stringify({ model: t.model }), text: t.providers.length > 1 ? `${t.model} (all providers)` : t.model });
    if (t.providers.length > 1) for (const p of t.providers) out.push({ value: JSON.stringify({ model: t.model, provider: p }), text: `${t.model} @ ${p}` });
  }
  return out;
});

async function load() {
  const mine = ++request;
  try {
    const f = selected.value ? JSON.parse(selected.value) : {};
    const q = new URLSearchParams();
    if (f.model) q.set('model', f.model);
    if (f.provider != null) q.set('provider', f.provider);
    const data = await api.get(`/api/usage${q.size ? `?${q}` : ''}`);
    if (mine !== request) return;
    days.value = data.days || [];
    stats.value = data.statistics || null;
    targets.value = data.statistics?.targets || [];
    path.value = [];
    error.value = '';
    loaded.value = true;
    // A choice that no longer exists (the data changed underneath) would show blank.
    if (!filterOptions.value.some((o) => o.value === selected.value)) selected.value = '';
  } catch (err) {
    if (mine === request) error.value = `Couldn't load usage (${err.message}).`;
  }
}

const { isOpen } = usePanel(PANEL.STATISTICS, { onOpen: load });
</script>

<template>
  <section id="statistics" :class="{ open: isOpen }" aria-label="Usage">
    <div class="panel-head">
      <h2>Usage</h2>
      <select v-if="filterOptions.length > 1" id="statisticsFilter" v-model="selected" aria-label="Show usage for" @change="load">
        <option v-for="o in filterOptions" :key="o.value" :value="o.value">{{ o.text }}</option>
      </select>
    </div>
    <div class="page-body">
      <p v-if="error" class="page-error" role="alert">{{ error }}</p>
      <p v-else-if="loaded && !kpis.length && !days.length" class="page-empty">No model usage recorded yet.</p>

      <template v-if="kpis.length">
        <div class="kpis">
          <div v-for="k in kpis" :key="k.label" class="kpi">
            <div class="kpi-label">{{ k.label }}</div>
            <div class="kpi-value">{{ k.value }}</div>
            <div class="kpi-sub">{{ k.sub }}</div>
          </div>
        </div>
        <p v-if="coverage" id="statisticsCoverage" class="page-note">{{ coverage }}</p>
      </template>

      <section v-if="days.length" class="page-section">
        <div class="page-section-h">
          <h3>Tokens over time</h3>
          <nav class="crumbs" aria-label="Period">
            <template v-for="(crumb, i) in ['All time', ...path]" :key="i">
              <span v-if="i" aria-hidden="true">/</span>
              <button v-if="i < path.length" type="button" class="crumb" @click="path = path.slice(0, i)">{{ i ? crumbLabel(crumb) : crumb }}</button>
              <span v-else class="crumb-current" aria-current="page">{{ i ? crumbLabel(crumb) : crumb }}</span>
            </template>
          </nav>
        </div>
        <p class="page-note">
          {{ fmt(scopedTotals.in) }} in · {{ fmt(scopedTotals.out) }} out · {{ fmt(scopedTotals.cached) }} cached{{ canDrill ? ' · select a bar to see its breakdown' : '' }}
        </p>
        <div class="usage-bars">
          <component :is="canDrill ? 'button' : 'div'" v-for="b in buckets" :key="b.key" class="usage-bar-row"
                     :class="{ clickable: canDrill }" :type="canDrill ? 'button' : undefined" :title="b.title"
                     :aria-label="canDrill ? `Show ${crumbLabel(b.key)}` : undefined" @click="canDrill && (path = [...path, b.key])">
            <span class="usage-bar-label">{{ b.label }}</span>
            <span class="usage-bar-track"><span class="usage-bar-fill" :style="{ width: `${Math.max((b.total / maxBucket) * 100, 1)}%` }">
              <span v-for="m in b.models.filter((x) => x.in || x.out)" :key="m.model" class="usage-bar-seg"
                    :style="{ flexGrow: m.in + m.out, background: colorFor(m.model) }" />
            </span></span>
            <span class="usage-bar-count">{{ fmt(b.total) }}</span>
          </component>
        </div>
        <div v-if="allModels.length > 1" class="legend">
          <span v-for="m in allModels" :key="m.model" class="legend-item"><span class="legend-swatch" :style="{ background: colorFor(m.model) }" />{{ m.model }}</span>
        </div>
      </section>

      <section v-if="byModel.length" class="page-section">
        <div class="page-section-h"><h3>By model</h3><span class="meta">all time</span></div>
        <div class="table-scroll">
          <table class="data-table">
            <thead><tr><th>Model</th><th class="num">Requests</th><th class="num">Input</th><th class="num">Cached</th><th class="num">Output</th><th class="num">Cost</th></tr></thead>
            <tbody>
              <tr v-for="m in byModel" :key="m.model">
                <td class="name"><span v-if="byModel.length > 1" class="legend-swatch" :style="{ background: colorFor(m.model) }" />{{ m.model }}</td>
                <td class="num">{{ fmt(m.requests) }}</td>
                <td class="num">{{ fmt(m.in) }}</td>
                <td class="num">{{ fmt(m.cached) }}</td>
                <td class="num">{{ fmt(m.out) }}</td>
                <td class="num" :title="m.partial ? 'Some requests reported no cost' : undefined">{{ money(m.cost) }}{{ m.partial ? '*' : '' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section v-if="stats?.rounds" class="page-section">
        <div class="page-section-h"><h3>Tool calls</h3><span class="meta">all rounds</span></div>
        <p v-if="!tools.length" class="page-note">No tool calls recorded yet.</p>
        <table v-else class="data-table">
          <thead><tr><th>Tool</th><th class="bar-col" aria-hidden="true" /><th class="num">Calls</th></tr></thead>
          <tbody>
            <tr v-for="t in tools" :key="t.name">
              <td class="name">{{ t.name }}</td>
              <td class="bar-col"><span class="inline-bar" :style="{ width: `${(t.calls / maxCalls) * 100}%` }" /></td>
              <td class="num">{{ fmt(t.calls) }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section v-if="averages.length" class="page-section">
        <div class="page-section-h"><h3>Averages</h3></div>
        <dl class="kv">
          <template v-for="a in averages" :key="a.label">
            <dt :title="a.hint || undefined">{{ a.label }}</dt><dd>{{ a.value }}</dd>
          </template>
        </dl>
      </section>

      <details v-if="days.length" class="page-section page-details">
        <summary><h3>Where the tokens went</h3><span class="meta">{{ rangeName }}</span></summary>
        <p class="page-note">
          {{ attribution.requests
            ? `${fmt(attribution.requests)} of ${fmt(attribution.totalRequests)} requests have saved attribution. Provider totals are authoritative; ~ marks character-based estimates. Cache reads are a subset of input and cannot be assigned to components.`
            : 'No saved token attribution in this range. New requests record it; older prompts are not reconstructed.' }}
        </p>
        <template v-if="attribution.requests">
          <div v-for="s in attribution.sides" :key="s.side" class="composition">
            <h4>{{ s.side === 'input' ? 'Input' : 'Output' }} <span class="meta">{{ fmt(s.total) }} tokens over {{ fmt(s.reported) }}/{{ fmt(attribution.requests) }} requests{{ s.side === 'input' && s.cached ? `, ${fmt(s.cached)} cached` : '' }}</span></h4>
            <table class="data-table">
              <tbody>
                <tr v-for="(b, i) in s.list" :key="i">
                  <td>{{ label(b.category) }}</td>
                  <td class="bar-col"><span v-if="b.tokens > 0" class="inline-bar" :style="{ width: `${(b.tokens / s.max) * 100}%` }" /></td>
                  <td class="num">{{ b.source === 'provider' ? '' : '~' }}{{ fmt(b.tokens) }}</td>
                  <td class="num share">{{ s.complete && s.total > 0 ? pct(b.tokens / s.total) : '—' }}</td>
                </tr>
              </tbody>
            </table>
            <p v-if="s.negative" class="page-note">Estimates exceed provider totals in some categories. The signed delta shows the difference; components have not been rescaled.</p>
          </div>
          <div v-if="attribution.overhead.length" class="composition">
            <h4>Tool and MCP overhead <span class="meta">estimated, by server</span></h4>
            <table class="data-table">
              <tbody><tr v-for="[name, count] in attribution.overhead" :key="name"><td>{{ name }}</td><td class="num">~{{ fmt(count) }}</td></tr></tbody>
            </table>
          </div>
        </template>
      </details>

      <details v-if="stats?.rounds" class="page-section page-details" :open="(misses.prefix || 0) > 0">
        <summary><h3>Cache misses</h3><span class="meta">{{ judged ? `${fmt(missTotal)} of ${fmt(judged)} comparable requests` : 'nothing to compare yet' }}</span></summary>
        <p v-if="!judged" class="page-note">A chat needs two rounds from a provider that reports cache figures.</p>
        <table v-else class="data-table">
          <thead><tr><th>Reason</th><th>What it means</th><th class="num">Misses</th></tr></thead>
          <tbody>
            <tr v-for="[key, text, hint] in MISS_LABELS" :key="key" :class="{ quiet: !misses[key] }">
              <td class="nowrap">{{ text }}</td><td class="muted">{{ hint }}</td><td class="num">{{ fmt(misses[key] || 0) }}</td>
            </tr>
          </tbody>
        </table>
      </details>
    </div>
  </section>
</template>
