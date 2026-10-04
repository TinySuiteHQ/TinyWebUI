import { scope } from './scope.js';

/** What an aux_usage row was spent on. */
export const AUX_KIND = { CHECKPOINT: 'checkpoint' };
import { inputTokens, outputTokens, cacheReads, tally } from '../../public/shared/usage.js';

// Token and cost statistics over stored messages.
// One area of the Store; see index.js.

/** Adds one stored attribution snapshot (see harness/attribution.js) into a running total. */
function mergeAttribution(target, snapshot) {
  if (!snapshot || snapshot.version !== 1) return target;
  target ||= { requests: 0, input: { total: 0, reported: 0, buckets: [] }, output: { total: 0, reported: 0, buckets: [] }, cached: 0 };
  target.requests++;
  for (const side of ['input', 'output']) {
    const value = snapshot[side];
    if (!value) continue;
    if (value.total !== null) { target[side].total += value.total; target[side].reported++; }
    for (const b of value.buckets || []) {
      let existing = target[side].buckets.find((x) => x.category === b.category && x.source === b.source && x.capability === b.capability);
      if (!existing) target[side].buckets.push(existing = { ...b, tokens: 0 });
      existing.tokens += b.tokens;
    }
  }
  target.cached += snapshot.cached || 0;
  return target;
}

/** Causes of a cache miss, most actionable first. */
export const MISS = { PREFIX: 'prefix', SWITCH: 'switch', EXPIRED: 'expired', STUB: 'stub', PROVIDER: 'provider' };

// How long an entry outlives its last use on most providers. Longer TTLs exist
// (Anthropic's 1h, Gemini's explicit caches), so a gap past this is a likely
// expiry, not a certain one.
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Why a round missed the cache, given the round before it in the same chat:
 * null for a hit or a round that can't be judged. A miss is less than half of
 * the previous request cached -- that request is what this one should have
 * found, and providers cache in blocks, so "less than all" is normal.
 * `prefix` is the fingerprint streamTurn() stores (see chat/llm.js).
 */
export function cacheMiss(round, prev) {
  const { usage, at } = round;
  const prefix = usage.prefix;
  if (!prev || !prefix || prefix.previous == null || !tally([usage]).reported) return null;
  if ((cacheReads(usage) ?? 0) >= prev.input / 2) return null;
  if (prefix.matched < prefix.previous) return prefix.stubSwap ? MISS.STUB : MISS.PREFIX;
  if (usage.provider && prev.provider && usage.provider !== prev.provider) return MISS.SWITCH;
  if (at != null && prev.at != null && at - prev.at > CACHE_TTL_MS) return MISS.EXPIRED;
  return MISS.PROVIDER;
}

/**
 * What caching saved, from costs providers already report. Within one model on
 * one upstream, every round's input cost is fresh * full + cached * cacheRate
 * with the same two prices, so rounds at different cache ratios pin both down
 * (least squares). The fit is trusted only if it reproduces every round to 1%:
 * a tiered or changed price would not, and then nothing is claimed.
 * `rounds`: [{ fresh, cached, inputCost }]. Returns null when it can't tell.
 */
export function derivedCacheRates(rounds) {
  if (rounds.length < 2) return null;
  let ff = 0, fc = 0, cc = 0, fy = 0, cy = 0;
  for (const { fresh, cached, inputCost: y } of rounds) {
    ff += fresh * fresh; fc += fresh * cached; cc += cached * cached; fy += fresh * y; cy += cached * y;
  }
  const det = ff * cc - fc * fc;
  // All rounds at one cache ratio: the two prices can't be told apart.
  if (!(det > 1e-9 * ff * cc)) return null;
  const full = (fy * cc - fc * cy) / det;
  const cacheRate = (ff * cy - fc * fy) / det;
  if (!(full > 0) || cacheRate < -1e-12 || cacheRate >= full) return null;
  const fits = rounds.every(({ fresh, cached, inputCost }) =>
    Math.abs(fresh * full + cached * cacheRate - inputCost) <= 0.01 * inputCost + 1e-9);
  return fits ? { full, cache: Math.max(cacheRate, 0) } : null;
}

/**
 * Which rounds a statistics view covers: `model` alone is every upstream that
 * served it; `provider` narrows to one ('' is rounds with none on record).
 */
const matches = (filter, model, provider) =>
  (!filter.model || model === filter.model)
  && (filter.provider == null || (provider ?? '') === filter.provider);

/** Every model seen, with the upstreams that served it, for the filter. */
function addTarget(targets, model, provider) {
  if (!targets.has(model)) targets.set(model, new Set());
  if (provider) targets.get(model).add(provider);
}
const listTargets = (targets) => [...targets].map(([model, providers]) => ({ model, providers: [...providers].sort() }))
  .sort((a, b) => a.model.localeCompare(b.model));

export class UsageStore {
  constructor(db, deps = {}) {
    this.db = db;
    Object.assign(this, deps);
  }

  /** Usage of a request made for a chat that is not one of its turns. `kind`: AUX_KIND. */
  addAuxiliary(chatId, { kind, model, usage }) {
    this.db.prepare('INSERT INTO aux_usage (chat_id, kind, model, usage_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(chatId, kind, model ?? null, JSON.stringify(usage ?? {}), Date.now());
  }

  /** Usage of one chat's auxiliary requests, oldest first. */
  auxiliaryFor(chatId) {
    return this.db.prepare('SELECT usage_json FROM aux_usage WHERE chat_id = ? ORDER BY id').all(chatId)
      .map((r) => JSON.parse(r.usage_json));
  }

  /**
   * Rolls up token usage across every assistant round that has it, bucketed
   * by local calendar day ('YYYY-MM-DD', via SQLite's julianday/strftime on
   * created_at) and by model. Buckets are computed in SQL rather than in JS
   * so a year of history doesn't have to be pulled across just to summarize
   * it. Field-name variance across providers (prompt_tokens vs input_tokens,
   * the several cache-token spellings) is normalized here the same way
   * transcript.js's tally() does client-side for a single round.
   *
   * Rows predating model/timestamp tracking have neither column set and land
   * in an 'unknown' day bucket instead of being dropped, so their tokens
   * still show up here the same way their cost already does in
   * usageStatistics() below.
   */
  rollup(userId, filter = {}) {
    const s = scope(userId, 'c.user_id');
    const rows = this.db.prepare(`
      SELECT CASE WHEN m.created_at IS NOT NULL
               THEN strftime('%Y-%m-%d', m.created_at / 1000, 'unixepoch')
               ELSE 'unknown' END AS day,
             m.model, m.usage_json
      FROM (SELECT chat_id, created_at, model, usage_json FROM messages
            UNION ALL SELECT chat_id, created_at, model, usage_json FROM aux_usage) m
      JOIN chats c ON c.id=m.chat_id
      WHERE m.usage_json IS NOT NULL AND ${s.sql}
    `).all(...s.params);

    const byDay = new Map();
    for (const row of rows) {
      let u;
      try { u = JSON.parse(row.usage_json); } catch { continue; }
      const inTok = inputTokens(u) ?? 0;
      const outTok = outputTokens(u) ?? 0;
      const cached = cacheReads(u) ?? 0;
      const model = row.model || u.model || 'unknown';
      if (!matches(filter, model, u.provider)) continue;

      const cost = u.cost != null && Number.isFinite(Number(u.cost)) ? Number(u.cost) : null;
      if (!byDay.has(row.day)) byDay.set(row.day, { day: row.day, in: 0, out: 0, cached: 0, models: new Map() });
      const d = byDay.get(row.day);
      d.in += inTok; d.out += outTok; d.cached += cached;

      if (!d.models.has(model)) d.models.set(model, { model, in: 0, out: 0, cached: 0 });
      const m = d.models.get(model);
      m.in += inTok; m.out += outTok; m.cached += cached;
      m.attribution = mergeAttribution(m.attribution, u.attribution);
      m.requests = (m.requests || 0) + 1;
      if (cost !== null) {
        d.cost = (d.cost || 0) + cost;
        m.cost = (m.cost || 0) + cost;
        d.pricedRounds = (d.pricedRounds || 0) + 1;
        m.pricedRounds = (m.pricedRounds || 0) + 1;
      }
    }

    return [...byDay.values()]
      .map((d) => ({ ...d, models: [...d.models.values()] }))
      .sort((a, b) => a.day.localeCompare(b.day));
  }

  statistics(userId, filter = {}) {
    const s = scope(userId, 'c.user_id');
    const rows = this.db.prepare(`SELECT m.chat_id,m.seq,m.role,m.content,m.tool_calls_json,m.model,m.usage_json,m.created_at
      FROM messages m JOIN chats c ON c.id=m.chat_id WHERE ${s.sql} ORDER BY m.chat_id,m.seq`).all(...s.params);
    const models = new Map();
    const tools = new Map();
    const summary = { rounds: 0, pricedRounds: 0, reportedCost: 0, completedAnswers: 0,
      pricedAnswers: 0, answerCostTotal: 0, answerTokens: 0, tokenAnswers: 0, toolCalls: 0 };
    // Hit share counts only rounds whose provider reports cache figures: one
    // that reports nothing would otherwise read as a 0% hit and drag it down.
    const cache = { rounds: 0, input: 0, cached: 0, written: 0, saved: 0, savedRounds: 0, savedCost: 0,
      judged: 0, misses: Object.fromEntries(Object.values(MISS).map((k) => [k, 0])) };
    let prevRound = null;
    // Per model @ upstream, for derivedCacheRates().
    const priced = new Map();
    const targets = new Map();
    let chatId = null;
    let answer = null;
    const finishAnswer = () => {
      if (!answer) return;
      if (answer.complete) {
        summary.completedAnswers++;
        summary.answerRoundsTotal = (summary.answerRoundsTotal || 0) + answer.rounds;
        if (answer.rounds && answer.pricedRounds === answer.rounds) {
          summary.pricedAnswers++;
          summary.answerCostTotal += answer.cost;
        }
        if (answer.rounds && answer.usageRounds === answer.rounds) { summary.tokenAnswers++; summary.answerTokens += answer.tokens; }
      }
    };
    for (const row of rows) {
      if (row.chat_id !== chatId) { finishAnswer(); chatId = row.chat_id; answer = null; prevRound = null; }
      if (row.role === 'user') { finishAnswer(); answer = { rounds:0, usageRounds:0, pricedRounds:0, cost:0, tokens:0, complete:false }; continue; }
      if (row.role !== 'assistant') continue;
      let usage = null;
      try { if (row.usage_json) usage = JSON.parse(row.usage_json); } catch { /* ignore malformed historic usage */ }
      const model = row.model || usage?.model || 'unknown';
      addTarget(targets, model, usage?.provider);
      if (!matches(filter, model, usage?.provider)) {
        // Still the round the next one is judged against: a filtered-out
        // upstream in between is exactly what makes the next one a switch.
        if (usage) prevRound = { input: tally([usage]).in, provider: usage.provider ?? null, at: row.created_at };
        continue;
      }
      summary.rounds++;
      if (answer) answer.rounds++;
      if (!models.has(model)) models.set(model, { model, in:0, out:0, cached:0, rounds:0, pricedRounds:0, cost:0 });
      const m = models.get(model);
      m.rounds++;
      if (row.tool_calls_json) {
        let calls = null;
        try { calls = JSON.parse(row.tool_calls_json); } catch { /* ignore malformed historic tool_calls */ }
        for (const call of calls || []) {
          const name = call?.function?.name;
          if (!name) continue;
          summary.toolCalls++;
          tools.set(name, (tools.get(name) || 0) + 1);
        }
      }
      if (usage) {
        const inTok = inputTokens(usage) ?? 0;
        const outTok = outputTokens(usage) ?? 0;
        const cached = cacheReads(usage) ?? 0;
        const costValue = usage.cost ?? usage.total_cost;
        const cost = costValue !== undefined && costValue !== null && Number.isFinite(Number(costValue)) ? Number(costValue) : null;
        m.in += inTok; m.out += outTok; m.cached += cached;
        const t = tally([usage]);
        if (t.reported) { cache.rounds++; cache.input += t.in; cache.cached += t.cached; cache.written += t.written; }
        if (t.reported && usage.prefix?.previous != null && prevRound) {
          cache.judged++;
          const miss = cacheMiss({ usage, at: row.created_at }, prevRound);
          if (miss) cache.misses[miss]++;
        }
        prevRound = { input: t.in, provider: usage.provider ?? null, at: row.created_at };
        const inputCost = Number(usage.cost_details?.upstream_inference_prompt_cost);
        const key = `${model}\u0000${usage.provider ?? ''}`;
        if (!priced.has(key)) priced.set(key, { model, provider: usage.provider ?? null, rounds: [], cost: 0, discount: 0, discounted: 0 });
        const g = priced.get(key);
        if (t.reported && Number.isFinite(inputCost) && inputCost > 0) g.rounds.push({ fresh: t.in - t.cached, cached: t.cached, inputCost, cost });
        if (usage.cache_discount != null && Number.isFinite(Number(usage.cache_discount))) { g.discounted++; g.discount += Number(usage.cache_discount); g.cost += cost ?? 0; }
        if (cost !== null) { m.cost += cost; m.pricedRounds++; summary.pricedRounds++; summary.reportedCost += cost; }
        if (answer) {
          if (inputTokens(usage) !== null && outputTokens(usage) !== null) answer.usageRounds++;
          answer.tokens += inTok + outTok;
          if (cost !== null) { answer.pricedRounds++; answer.cost += cost; }
        }
      }
      if (!row.tool_calls_json && String(row.content || '').trim()) {
        if (answer) answer.complete = true;
      }
    }
    finishAnswer();
    // A provider's own figure wins; otherwise derive it from what it charged.
    const rates = [];
    for (const g of priced.values()) {
      if (g.discounted) { cache.saved += g.discount; cache.savedCost += g.cost; cache.savedRounds += g.discounted; continue; }
      const r = derivedCacheRates(g.rounds);
      if (!r) continue;
      const cached = g.rounds.reduce((n, x) => n + x.cached, 0);
      cache.saved += cached * (r.full - r.cache);
      cache.savedCost += g.rounds.reduce((n, x) => n + (x.cost ?? 0), 0);
      cache.savedRounds += g.rounds.length;
      rates.push({ model: g.model, provider: g.provider, full: r.full, cache: r.cache });
    }
    // Kept out of rounds and answers: these are not turns, but they are spent.
    const aux = { requests: 0, pricedRequests: 0, cost: 0 };
    for (const row of this.db.prepare(`SELECT a.model, a.usage_json FROM aux_usage a
      JOIN chats c ON c.id=a.chat_id WHERE ${s.sql}`).all(...s.params)) {
      let usage = null;
      try { usage = JSON.parse(row.usage_json); } catch { continue; }
      const model = row.model || usage.model || 'unknown';
      addTarget(targets, model, usage.provider);
      if (!matches(filter, model, usage.provider)) continue;
      aux.requests++;
      const costValue = usage.cost ?? usage.total_cost;
      if (costValue != null && Number.isFinite(Number(costValue))) { aux.pricedRequests++; aux.cost += Number(costValue); }
    }
    return {
      targets: listTargets(targets),
      auxiliary: { requests: aux.requests, cost: aux.pricedRequests ? aux.cost : null },
      cache: {
        reportedRounds: cache.rounds,
        input: cache.input,
        cached: cache.cached,
        written: cache.written,
        hitShare: cache.input ? cache.cached / cache.input : null,
        saved: cache.savedRounds ? cache.saved : null,
        // Share of what those rounds would have cost uncached.
        savedShare: cache.savedRounds && cache.saved + cache.savedCost > 0 ? cache.saved / (cache.saved + cache.savedCost) : null,
        rates,
        savedRounds: cache.savedRounds,
        // Rounds with a previous request to compare against; the rest (a
        // chat's first round, the first after a restart, old rows) are unknown.
        judged: cache.judged,
        misses: cache.misses
      },
      rounds: summary.rounds,
      pricedRounds: summary.pricedRounds,
      unpricedRounds: summary.rounds - summary.pricedRounds,
      reportedCost: summary.pricedRounds ? summary.reportedCost : null,
      averageRoundCost: summary.pricedRounds ? summary.reportedCost / summary.pricedRounds : null,
      completedAnswers: summary.completedAnswers,
      pricedAnswers: summary.pricedAnswers,
      averageAnswerCost: summary.pricedAnswers ? summary.answerCostTotal / summary.pricedAnswers : null,
      averageAnswerTokens: summary.tokenAnswers ? summary.answerTokens / summary.tokenAnswers : null,
      averageRoundsPerAnswer: summary.completedAnswers ? summary.answerRoundsTotal / summary.completedAnswers : null,
      toolCalls: summary.toolCalls,
      models: [...models.values()].map((m) => ({ ...m, cost: m.pricedRounds ? m.cost : null }))
        .sort((a,b) => b.in + b.out - a.in - a.out),
      tools: [...tools.entries()].map(([name, calls]) => ({ name, calls }))
        .sort((a, b) => b.calls - a.calls)
    };
  }
}
