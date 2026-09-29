import { scope } from './scope.js';

// Token and cost statistics over stored messages.
// One area of the Store; see index.js.

/** Adds one stored attribution snapshot (see chat/attribution.js) into a running total. */
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

export class UsageStore {
  constructor(db, deps = {}) {
    this.db = db;
    Object.assign(this, deps);
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
  rollup(userId) {
    const s = scope(userId, 'c.user_id');
    const rows = this.db.prepare(`
      SELECT CASE WHEN m.created_at IS NOT NULL
               THEN strftime('%Y-%m-%d', m.created_at / 1000, 'unixepoch')
               ELSE 'unknown' END AS day,
             m.model, m.usage_json
      FROM messages m JOIN chats c ON c.id=m.chat_id
      WHERE m.usage_json IS NOT NULL AND ${s.sql}
    `).all(...s.params);

    const byDay = new Map();
    for (const row of rows) {
      let u;
      try { u = JSON.parse(row.usage_json); } catch { continue; }
      const inTok = u.prompt_tokens ?? u.input_tokens ?? 0;
      const outTok = u.completion_tokens ?? u.output_tokens ?? 0;
      const cached = u.prompt_tokens_details?.cached_tokens
        ?? u.cache_read_input_tokens
        ?? u.cached_tokens
        ?? 0;
      const model = row.model || u.model || 'unknown';

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

  statistics(userId) {
    const s = scope(userId, 'c.user_id');
    const rows = this.db.prepare(`SELECT m.chat_id,m.seq,m.role,m.content,m.tool_calls_json,m.model,m.usage_json
      FROM messages m JOIN chats c ON c.id=m.chat_id WHERE ${s.sql} ORDER BY m.chat_id,m.seq`).all(...s.params);
    const models = new Map();
    const tools = new Map();
    const summary = { rounds: 0, pricedRounds: 0, reportedCost: 0, completedAnswers: 0,
      pricedAnswers: 0, answerCostTotal: 0, answerTokens: 0, tokenAnswers: 0, toolCalls: 0 };
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
      if (row.chat_id !== chatId) { finishAnswer(); chatId = row.chat_id; answer = null; }
      if (row.role === 'user') { finishAnswer(); answer = { rounds:0, usageRounds:0, pricedRounds:0, cost:0, tokens:0, complete:false }; continue; }
      if (row.role !== 'assistant') continue;
      summary.rounds++;
      if (answer) answer.rounds++;
      let usage = null;
      try { if (row.usage_json) usage = JSON.parse(row.usage_json); } catch { /* ignore malformed historic usage */ }
      const model = row.model || usage?.model || 'unknown';
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
        const inTok = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
        const outTok = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
        const cached = Number(usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens ?? usage.cached_tokens ?? 0) || 0;
        const costValue = usage.cost ?? usage.total_cost;
        const cost = costValue !== undefined && costValue !== null && Number.isFinite(Number(costValue)) ? Number(costValue) : null;
        m.in += inTok; m.out += outTok; m.cached += cached;
        if (cost !== null) { m.cost += cost; m.pricedRounds++; summary.pricedRounds++; summary.reportedCost += cost; }
        if (answer) {
          if ((usage.prompt_tokens ?? usage.input_tokens) != null && (usage.completion_tokens ?? usage.output_tokens) != null) answer.usageRounds++;
          answer.tokens += inTok + outTok;
          if (cost !== null) { answer.pricedRounds++; answer.cost += cost; }
        }
      }
      if (!row.tool_calls_json && String(row.content || '').trim()) {
        if (answer) answer.complete = true;
      }
    }
    finishAnswer();
    return {
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
