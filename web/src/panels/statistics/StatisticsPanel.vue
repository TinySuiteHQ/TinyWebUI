<script setup lang="ts">
/**
 * Token usage and cost. The server hands back one row per calendar day;
 * everything coarser (years, months) is folded here, since a year of daily
 * rows is cheap to carry but expensive to re-derive per click.
 */
import { computed, ref } from 'vue';
import { api } from '../../core/api.ts';
import { PANEL } from '../../stores/panels.ts';
import { usePanel } from '../usePanel.ts';

// /api/usage is a wide report read field by field.
type Json = any;
type ModelTotal = { model: string, in: number, out: number, cached: number };
type Day = { day: string, models: (ModelTotal & { requests?: number, attribution?: Json })[] };

const days = ref<Day[]>([]);
const stats = ref<Json | null>(null);
const targets = ref<Json[]>([]);
const error = ref('');
// Drill-down: [] is every year, ['2026'] its months, ['2026', '2026-03'] its days.
const path = ref<string[]>([]);
// '' is everything, else JSON of { model, provider? }.
const selected = ref('');
let request = 0;

const fmt = (n: number) => n.toLocaleString();
const costFmt = (v: number | null | undefined) => (v == null ? 'not reported' : `$${Number(v).toFixed(6)}`);
const pct = (share: number) => `${(share * 100).toFixed(1)}%`;

// A model keeps its colour for the whole session, at every drill-down level.
const PALETTE = ['--accent', '--tool', '--err', '--muted', '--faint'];
const colors = new Map<string, string>();
function colorFor(model: string) {
  if (!colors.has(model)) colors.set(model, PALETTE[colors.size % PALETTE.length] as string);
  return `var(${colors.get(model)})`;
}

function sumModels(rows: Day[]): ModelTotal[] {
  const totals = new Map<string, ModelTotal>();
  for (const row of rows) for (const m of row.models) {
    const t = totals.get(m.model) || { model: m.model, in: 0, out: 0, cached: 0 };
    t.in += m.in; t.out += m.out; t.cached += m.cached;
    totals.set(m.model, t);
  }
  return [...totals.values()].sort((a, b) => b.in + b.out - (a.in + a.out));
}

const level = computed(() => (path.value.length === 0 ? 'year' : path.value.length === 1 ? 'month' : 'day'));
const scoped = computed(() => (path.value.length ? days.value.filter((d) => d.day.startsWith(path.value[path.value.length - 1] as string)) : days.value));
const models = computed(() => sumModels(scoped.value));
const totals = computed(() => models.value.reduce((t, m) => ({ in: t.in + m.in, out: t.out + m.out, cached: t.cached + m.cached }), { in: 0, out: 0, cached: 0 }));

/** Bars: years, months in a year, or days. The one place length compares one bar with another. */
const buckets = computed(() => {
  const rows = scoped.value;
  if (level.value === 'day') {
    return rows.map((d) => { const m = sumModels([d]); return { key: d.day, label: d.day.slice(8), models: m, total: m.reduce((n, x) => n + x.in + x.out, 0) }; })
      .sort((a, b) => a.key.localeCompare(b.key));
  }
  const groups = new Map<string, Day[]>();
  for (const row of rows) {
    const key = level.value === 'year' ? row.day.slice(0, 4) : row.day.slice(0, 7);
    groups.set(key, [...(groups.get(key) || []), row]);
  }
  return [...groups.entries()].map(([key, list]) => {
    const m = sumModels(list);
    return { key, label: level.value === 'year' ? key : key.slice(5), models: m, total: m.reduce((n, x) => n + x.in + x.out, 0) };
  }).sort((a, b) => a.key.localeCompare(b.key));
});
const maxBucket = computed(() => Math.max(...buckets.value.map((b) => b.total), 1));

/** One model's own split: fresh input, cached input (a subset of input), output. */
function split(m: ModelTotal) {
  const total = m.in + m.out || 1;
  const cachedIn = Math.min(m.cached, m.in);
  return [['fresh', m.in - cachedIn], ['cached', cachedIn], ['out', m.out]]
    .filter(([, n]) => n).map(([cls, n]) => ({ cls: cls as string, width: `${((n as number) / total) * 100}%` }));
}

/* ---------- cost ---------- */

const cache = computed(() => stats.value?.cache || {});
const rates = computed(() => (cache.value.rates || []).map((r: Json) => `${r.model}${r.provider ? ` @ ${r.provider}` : ''}: `
  + `$${(r.full * 1e6).toFixed(3)}/M full, $${(r.cache * 1e6).toFixed(3)}/M cached`).join('\n'));
const tiles = computed(() => {
  const s = stats.value;
  if (!s?.rounds) return [];
  const c = cache.value;
  return [
    { label: 'cache saved', value: costFmt(c.saved), sub: c.savedShare == null ? '' : `${pct(c.savedShare)} off the bill`,
      hint: 'Share of what these requests would have cost with no cache. Where the provider does not report it, it is worked out from the input cost it charged at different cache ratios.' + (rates.value ? `\n\n${rates.value}` : '') },
    { label: 'cache hit share', value: c.hitShare == null ? '—' : pct(c.hitShare), sub: c.reportedRounds ? `${fmt(c.cached)} of ${fmt(c.input)} input` : '',
      hint: 'Input tokens read from cache, over requests whose provider reports cache figures.' },
    { label: 'reported cost', value: costFmt(s.reportedCost), sub: '', hint: '' },
    { label: 'average model request', value: costFmt(s.averageRoundCost), sub: '', hint: '' },
    { label: 'average complete answer', value: costFmt(s.averageAnswerCost), sub: '', hint: 'All model requests of the answer, tool-work rounds included.' },
    { label: 'average answer tokens (all rounds)', value: s.averageAnswerTokens == null ? '—' : Math.round(s.averageAnswerTokens).toLocaleString(), sub: '', hint: '' },
    { label: 'average rounds per answer', value: s.averageRoundsPerAnswer == null ? '—' : s.averageRoundsPerAnswer.toFixed(1), sub: '', hint: '' }
  ];
});
// Only what is off: full coverage needs no sentence.
const coverage = computed(() => {
  const s = stats.value;
  if (!s?.rounds) return '';
  const notes: string[] = [];
  if (s.pricedRounds < s.rounds) notes.push(`${fmt(s.pricedRounds)} of ${fmt(s.rounds)} requests reported cost`);
  if (s.pricedAnswers < s.completedAnswers) notes.push(`${fmt(s.pricedAnswers)} of ${fmt(s.completedAnswers)} answers fully priced`);
  if (!cache.value.reportedRounds) notes.push('no provider has reported cache figures yet');
  if (s.auxiliary?.requests) notes.push(`conversation summaries: ${fmt(s.auxiliary.requests)} requests, ${costFmt(s.auxiliary.cost)}, not included above`);
  return notes.join(' · ');
});
const maxCalls = computed(() => Math.max(1, ...(stats.value?.tools || []).map((t: Json) => t.calls)));

// Ordered like the server's MISS: the first is the one that is ours to fix.
const MISS_LABELS = [
  ['prefix', 'prefix changed', 'we altered something already sent; worth investigating'],
  ['switch', 'provider switched', 'a different upstream served it, with its own cache'],
  ['expired', 'expired', 'more than 5 minutes idle since the previous request'],
  ['stub', 'result stubbed', 'a large tool result switched to its stub after its turn, as planned'],
  ['provider', 'provider-side', 'same prefix, same upstream, in time, and it still missed']
] as const;
const judged = computed(() => (stats.value?.rounds ? cache.value.judged : 0));
const misses = computed(() => cache.value.misses || {});
const missTotal = computed(() => Object.values(misses.value as Record<string, number>).reduce((n, v) => n + v, 0));
const maxMiss = computed(() => Math.max(1, ...MISS_LABELS.map(([k]) => misses.value[k] || 0)));

/* ---------- attribution ---------- */

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
    const list = [...buckets.values()];
    const complete = reported === requests;
    // A signed provider delta is shown as is, never scaled away: negative
    // means the estimates exceed the provider's own total.
    const negative = list.some((b) => b.tokens < 0);
    return { side, list, total, reported, complete, negative, cached: side === 'input' ? snapshots.reduce((n, s) => n + s.cached, 0) : 0 };
  });
  const overhead = new Map<string, number>();
  for (const s of snapshots) for (const b of s.input.buckets) {
    if (!b.capability) continue;
    const key = `${b.capability} · ${label(b.category)}`;
    overhead.set(key, (overhead.get(key) || 0) + b.tokens);
  }
  return { requests, totalRequests, sides, overhead: [...overhead.entries()] };
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
    // A choice that no longer exists (the data changed underneath) would show blank.
    if (!filterOptions.value.some((o) => o.value === selected.value)) selected.value = '';
  } catch (err) {
    if (mine === request) error.value = `Couldn't load usage (${err.message}).`;
  }
}

const { isOpen } = usePanel(PANEL.STATISTICS, { onOpen: load });
</script>

<template>
  <section id="statistics" :class="{ open: isOpen }" aria-label="Statistics">
    <div class="automation-head">
      <h2>Statistics</h2>
      <span id="statisticsFilter">
        <select v-model="selected" aria-label="Statistics for model" @change="load">
          <option v-for="o in filterOptions" :key="o.value" :value="o.value">{{ o.text }}</option>
        </select>
      </span>
    </div>
    <div class="statistics-content">
      <div v-if="error" class="statistics-block"><div class="empty">{{ error }}</div></div>
      <section class="statistics-block">
        <div class="sec-h">cost and averages <span class="usage">provider-reported costs only</span></div>
        <div v-if="!tiles.length" class="empty">No model usage recorded yet.</div>
        <div v-else class="row">
          <div v-for="t in tiles" :key="t.label" :title="t.hint || undefined">
            <label>{{ t.label }}</label>
            <div class="usage-stat-value">{{ t.value }}</div>
            <div v-if="t.sub" class="usage-stat-sub">{{ t.sub }}</div>
          </div>
        </div>
        <div id="statisticsCoverage" class="usage">{{ coverage }}</div>
        <div v-if="stats?.models?.length" class="statistics-costs">
          <div v-for="m in stats.models" :key="m.model" class="statistics-cost-row">
            <span class="usage-model-name" :title="m.model">{{ m.model }}</span>
            <span>{{ costFmt(m.cost) }} · {{ m.pricedRounds }}/{{ m.rounds }} priced requests</span>
          </div>
        </div>
      </section>

      <section class="statistics-block">
        <div class="sec-h">
          token usage
          <span class="usage usage-range">
            <template v-for="(crumb, i) in ['all time', ...path]" :key="i">
              <template v-if="i"> / </template>
              <button type="button" class="crumb" @click="path = path.slice(0, i)">{{ crumb }}</button>
            </template>
          </span>
        </div>
        <div v-if="!days.length" class="empty">no usage recorded yet</div>
        <template v-else>
          <div class="row">
            <div><label>tokens in</label><div class="usage-stat-value">{{ fmt(totals.in) }}</div></div>
            <div><label>tokens out</label><div class="usage-stat-value">{{ fmt(totals.out) }}</div></div>
            <div><label>cached</label><div class="usage-stat-value">{{ fmt(totals.cached) }}</div></div>
          </div>
        </template>

        <div class="usage-distribution">
          <p class="usage-attribution-note">
            {{ attribution.requests
              ? `${fmt(attribution.requests)} of ${fmt(attribution.totalRequests)} requests have saved attribution. Provider totals are authoritative; ~ component counts are character-based estimates. Cache reads are a subset of input and cannot be assigned to individual components.`
              : 'No saved token attribution in this range. New requests will record it; historical prompts are not reconstructed.' }}
          </p>
          <template v-if="attribution.requests">
            <section v-for="s in attribution.sides" :key="s.side" class="usage-composition">
              <h3>{{ s.side === 'input' ? 'Input composition' : 'Output composition' }}</h3>
              <p class="usage-attribution-note">
                {{ fmt(s.total) }} provider-reported tokens across {{ fmt(s.reported) }}/{{ fmt(attribution.requests) }} requests.
                <template v-if="s.side === 'input'">{{ fmt(s.cached) }} cached input tokens reported.</template>
              </p>
              <div v-if="s.complete && s.total > 0 && !s.negative" class="usage-composition-track">
                <span v-for="(b, i) in s.list.filter((x) => x.tokens)" :key="i" :title="`${label(b.category)}: ${fmt(b.tokens)}`"
                      :style="{ width: `${(b.tokens / s.total) * 100}%`, background: `var(${PALETTE[i % PALETTE.length]})` }" />
              </div>
              <table class="usage-composition-table">
                <tr v-for="(b, i) in s.list" :key="i">
                  <td>{{ label(b.category) }}</td>
                  <td>{{ b.source === 'provider' ? '' : '~' }}{{ fmt(b.tokens) }} ({{ b.source === 'provider' ? 'provider' : 'estimated' }})</td>
                  <td>{{ s.complete && s.total > 0 ? `${((b.tokens / s.total) * 100).toFixed(1)}%` : '—' }}</td>
                </tr>
              </table>
              <p v-if="s.negative" class="usage-attribution-note">Estimates exceed provider totals in some categories. The signed delta shows the difference; components have not been rescaled.</p>
            </section>
            <details>
              <summary>Tool / MCP overhead by server</summary>
              <p v-for="[name, count] in attribution.overhead" :key="name" class="usage-attribution-note">{{ name }}: ~{{ fmt(count) }} estimated tokens</p>
            </details>
          </template>
        </div>

        <div v-if="models.length" class="usage-models">
          <div v-for="m in models" :key="m.model" class="usage-model-row">
            <span class="usage-model-name" :title="m.model">{{ m.model }}</span>
            <span class="usage-model-track"><span class="usage-model-bar">
              <span v-for="seg in split(m)" :key="seg.cls" class="usage-model-seg" :class="seg.cls" :style="{ width: seg.width }" />
            </span></span>
            <span class="usage-model-counts">{{ fmt(m.in) }} in · {{ fmt(m.out) }} out{{ m.cached ? ` · ${fmt(m.cached)} cached` : '' }}</span>
          </div>
          <div class="usage-model-legend">
            <span v-for="[cls, text] in [['fresh', 'in'], ['cached', 'cached'], ['out', 'out']]" :key="cls" class="usage-model-legend-item">
              <span class="usage-model-swatch" :class="cls" />{{ text }}
            </span>
          </div>
        </div>

        <div v-if="days.length" class="usage-bars">
          <div v-if="!buckets.length" class="empty">nothing here</div>
          <component :is="path.length < 3 ? 'button' : 'div'" v-for="b in buckets" :key="b.key" class="usage-bar-row"
                     :class="{ clickable: path.length < 3 }" :type="path.length < 3 ? 'button' : undefined"
                     :aria-label="path.length < 3 ? `Show ${b.key} usage details` : undefined" @click="path.length < 3 && (path = [...path, b.key])">
            <span class="usage-bar-label">{{ b.label }}</span>
            <span class="usage-bar-track"><span class="usage-bar-fill" :style="{ width: `${Math.max((b.total / maxBucket) * 100, 2)}%` }">
              <span v-for="m in b.models.filter((x) => x.in || x.out)" :key="m.model" class="usage-bar-seg"
                    :style="{ width: `${((m.in + m.out) / (b.total || 1)) * 100}%`, background: colorFor(m.model) }" />
            </span></span>
            <span class="usage-bar-count">{{ fmt(b.total) }}</span>
          </component>
          <div v-if="models.length > 1" class="usage-model-legend">
            <span v-for="m in models" :key="m.model" class="usage-model-legend-item">
              <span class="usage-model-swatch" :style="{ background: colorFor(m.model) }" />{{ m.model }}
            </span>
          </div>
        </div>
      </section>

      <section class="statistics-block">
        <div class="sec-h">agentic <span class="usage">tool calls across all rounds</span></div>
        <div class="statistics-costs">
          <div v-if="!stats?.tools?.length" class="empty">No tool calls recorded yet.</div>
          <div v-for="t in stats?.tools || []" :key="t.name" class="statistics-tool-row">
            <span class="statistics-tool-name" :title="t.name">{{ t.name }}</span>
            <span class="statistics-tool-track"><span class="statistics-tool-bar" :style="{ width: `${(t.calls / maxCalls) * 100}%` }" /></span>
            <span class="statistics-tool-count">{{ t.calls.toLocaleString() }} call{{ t.calls === 1 ? '' : 's' }}</span>
          </div>
        </div>
      </section>

      <section class="statistics-block">
        <div class="sec-h">cache misses <span class="usage">{{ judged ? `${fmt(missTotal)} of ${fmt(judged)} comparable requests missed` : '' }}</span></div>
        <div class="statistics-costs">
          <div v-if="!judged" class="empty">No requests to compare yet: a chat needs two rounds from a provider that reports cache figures.</div>
          <template v-else>
            <template v-for="[key, text, hint] in MISS_LABELS" :key="key">
              <div class="statistics-tool-row">
                <span class="statistics-tool-name">{{ text }}</span>
                <span class="statistics-tool-track"><span class="statistics-tool-bar" :style="{ width: `${((misses[key] || 0) / maxMiss) * 100}%` }" /></span>
                <span class="statistics-tool-count">{{ fmt(misses[key] || 0) }}</span>
              </div>
              <div class="statistics-miss-hint">{{ hint }}</div>
            </template>
          </template>
        </div>
      </section>
    </div>
  </section>
</template>
