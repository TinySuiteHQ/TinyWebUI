#!/usr/bin/env node
/**
 * Behaviour evals: replays a set of tasks against the real configured model
 * and scores what it did, so a change to the prompt or the harness can be
 * judged by the model's behaviour rather than by the bytes it was sent.
 *
 * Each task is a JSON file in evals/tasks/. It gives the model a prompt and a
 * set of scripted tools -- deterministic fake results, so a run measures the
 * model and the harness, not the weather -- and a list of checks on what came
 * back. Every task runs through the real runChat loop, so budgets, footers,
 * approval, dedup and compaction all behave exactly as they do in the app.
 *
 *   node evals/run.js                     run every task once
 *   node evals/run.js --repeat 3          three runs each (models are noisy)
 *   node evals/run.js --only date,inject  task names containing either word
 *   node evals/run.js --model x/y         override the configured model
 *   node evals/run.js --save baseline     keep this run as evals/results/baseline.json
 *   node evals/run.js --compare baseline  diff pass rates against a saved run
 *
 * Every run is also written to evals/results/<timestamp>.json.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config/config.js';
import { Store } from '../src/store.js';
import { runChat } from '../src/chat/llm.js';
import { check } from './checks.js';
import { askToolDef, callAskUser, ASK_USER } from '../src/tools/ask_tool.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const TASKS = join(HERE, 'tasks');
const RESULTS = join(HERE, 'results');

function parseArgs(argv) {
  const out = { repeat: 1, only: null, model: null, save: null, compare: null, concurrency: 4 };
  for (let i = 0; i < argv.length; i++) {
    const [k, v] = [argv[i], argv[i + 1]];
    if (k === '--repeat') { out.repeat = Math.max(1, Number(v) || 1); i++; }
    else if (k === '--only') { out.only = v.split(',').map((s) => s.trim()).filter(Boolean); i++; }
    else if (k === '--model') { out.model = v; i++; }
    else if (k === '--save') { out.save = v; i++; }
    else if (k === '--compare') { out.compare = v; i++; }
    else if (k === '--concurrency') { out.concurrency = Math.max(1, Number(v) || 1); i++; }
    else if (k === '--help' || k === '-h') { out.help = true; }
  }
  return out;
}

function loadTasks(only) {
  return readdirSync(TASKS)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => ({ file: f, ...JSON.parse(readFileSync(join(TASKS, f), 'utf8')) }))
    .filter((t) => !only || only.some((w) => t.name.includes(w)));
}

/** First scripted response whose `match` fits the call's arguments. */
function respond(tool, args) {
  for (const r of tool.responses || []) {
    const ok = Object.entries(r.match || {}).every(([key, pattern]) =>
      new RegExp(pattern, 'i').test(typeof args?.[key] === 'string' ? args[key] : JSON.stringify(args?.[key] ?? '')));
    if (ok) return r.result;
  }
  return `Error: no result for ${JSON.stringify(args)}`;
}

/** A hub made of the task's scripted tools, shaped like McpHub for runChat. */
function scriptedHub(task) {
  const byName = new Map((task.tools || []).map((t) => [t.name, t]));
  const calls = [];
  return {
    calls,
    defs: (task.tools || []).map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.parameters || { type: 'object', properties: {} }
      }
    })).concat(task.ask ? [askToolDef()] : []),
    instructionsBlock: () => task.serverInstructions || '',
    isIdempotent: (name) => Boolean(byName.get(name)?.idempotent),
    // ask_user changes nothing and never waits for approval, as in the app.
    isReadOnly: (name) => name === ASK_USER || Boolean(byName.get(name)?.readOnly),
    isLocal: () => false,
    call: async (name, args) => {
      calls.push({ name, args });
      // The real ask_user, answered from the task's script ("answer", or
      // no answer at all: the timeout fallback).
      if (name === ASK_USER && task.ask) {
        return callAskUser(args, {
          askUser: async () => (task.ask.answer ? { answered: true, answer: task.ask.answer } : { answered: false, reason: 'timeout' })
        });
      }
      const tool = byName.get(name);
      return tool ? respond(tool, args) : `Error: unknown tool "${name}"`;
    }
  };
}

async function runOnce(task, baseCfg) {
  const cfg = { ...baseCfg, ...(task.config || {}) };
  const hub = scriptedHub(task);
  const store = new Store(':memory:');
  const chat = store.createChat({ title: task.name });
  // Earlier turns, verbatim, for tasks about how the model uses history.
  for (const m of task.history || []) store.addMessage(chat.id, m);
  store.addMessage(chat.id, { role: 'user', content: task.prompt });

  const events = [];
  const approvals = [...(task.approvals || [])];
  const started = Date.now();
  let error = null;
  try {
    await runChat({
      cfg, chatId: chat.id, store, tools: hub.defs, hub,
      emit: (e) => events.push(e),
      signal: AbortSignal.timeout(task.timeoutMs || 180000),
      unattended: Boolean(task.unattended),
      // Scripted answers to approval prompts, in order; "deny" once they run out.
      approve: async () => approvals.shift() ?? 'deny'
    });
  } catch (err) {
    error = err.message;
  }

  const rows = store.messages(chat.id).slice((task.history || []).length + 1);
  const assistants = rows.filter((r) => r.role === 'assistant');
  const usage = assistants.map((r) => (r.usage_json ? JSON.parse(r.usage_json) : null)).filter(Boolean);
  const run = {
    answer: assistants.at(-1)?.content || '',
    calls: hub.calls,
    rounds: assistants.filter((r) => r.tool_calls_json).length,
    asked: events.filter((e) => e.type === 'approval').map((e) => e.name),
    error,
    ms: Date.now() - started,
    promptTokens: usage.reduce((n, u) => n + (u.prompt_tokens || 0), 0),
    completionTokens: usage.reduce((n, u) => n + (u.completion_tokens || 0), 0),
    cachedTokens: usage.reduce((n, u) => n + (u.prompt_tokens_details?.cached_tokens || 0), 0),
    cost: usage.reduce((n, u) => n + (u.cost || 0), 0)
  };

  run.checks = [];
  for (const c of task.checks || []) {
    run.checks.push({ ...(await check(c, run, cfg)), type: c.type, why: c.why || '' });
  }
  run.pass = !error && run.checks.every((c) => c.ok);
  return run;
}

/** Runs `jobs` with at most `n` in flight: a provider rate-limits a burst. */
async function pool(jobs, n) {
  const out = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, async () => {
    while (next < jobs.length) {
      const i = next++;
      out[i] = await jobs[i]();
    }
  }));
  return out;
}

const pct = (x) => `${Math.round(x * 100)}%`;
const pad = (s, n) => String(s).padEnd(n);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
    return;
  }
  const cfg = loadConfig();
  if (args.model) cfg.model = args.model;
  if (!cfg.apiKey && !/localhost|127\.0\.0\.1/.test(cfg.baseUrl)) {
    console.error('No API key configured -- evals call the real model.');
    process.exit(2);
  }
  // Evals answer approval prompts from the task, never from the live config's
  // per-tool overrides, so a local "always allow" can't change a result.
  cfg.confirmTools = [];
  cfg.autoApproveTools = [];

  const tasks = loadTasks(args.only);
  if (!tasks.length) { console.error('No tasks matched.'); process.exit(2); }
  console.log(`${tasks.length} task(s) × ${args.repeat} on ${cfg.model}\n`);

  const jobs = tasks.flatMap((task) =>
    Array.from({ length: args.repeat }, () => async () => {
      const run = await runOnce(task, cfg);
      process.stdout.write(run.pass ? '.' : 'F');
      return { task: task.name, run };
    }));
  const results = await pool(jobs, args.concurrency);
  console.log('\n');

  const summary = {};
  for (const task of tasks) {
    const runs = results.filter((r) => r.task === task.name).map((r) => r.run);
    const avg = (f) => runs.reduce((n, r) => n + f(r), 0) / runs.length;
    summary[task.name] = {
      passRate: avg((r) => (r.pass ? 1 : 0)),
      rounds: avg((r) => r.rounds),
      promptTokens: Math.round(avg((r) => r.promptTokens)),
      cost: avg((r) => r.cost),
      failures: runs.filter((r) => !r.pass).map((r) => ({
        error: r.error,
        failed: r.checks.filter((c) => !c.ok).map((c) => `${c.type}: ${c.detail}`),
        answer: r.answer.slice(0, 400),
        calls: r.calls.map((c) => `${c.name}(${JSON.stringify(c.args)})`)
      }))
    };
  }

  const baseline = args.compare && existsSync(join(RESULTS, `${args.compare}.json`))
    ? JSON.parse(readFileSync(join(RESULTS, `${args.compare}.json`), 'utf8')).summary
    : null;
  if (args.compare && !baseline) console.log(`(no saved run named "${args.compare}" to compare against)\n`);

  const width = Math.max(...tasks.map((t) => t.name.length), 4) + 2;
  console.log(`${pad('task', width)}${pad('pass', 7)}${baseline ? pad('was', 7) : ''}${pad('rounds', 8)}${pad('prompt tok', 12)}cost`);
  for (const [name, s] of Object.entries(summary)) {
    const was = baseline?.[name];
    const delta = was == null ? '' : s.passRate > was.passRate ? ' ▲' : s.passRate < was.passRate ? ' ▼' : '';
    console.log(
      pad(name, width)
      + pad(pct(s.passRate) + delta, 7)
      + (baseline ? pad(was ? pct(was.passRate) : '-', 7) : '')
      + pad(s.rounds.toFixed(1), 8)
      + pad(s.promptTokens.toLocaleString('en-US'), 12)
      + (s.cost ? `$${s.cost.toFixed(4)}` : '-')
    );
  }
  const all = results.map((r) => r.run);
  const total = all.filter((r) => r.pass).length / all.length;
  const cost = all.reduce((n, r) => n + r.cost, 0);
  console.log(`\noverall ${pct(total)} (${all.filter((r) => r.pass).length}/${all.length})${cost ? ` · $${cost.toFixed(4)}` : ''}`);

  for (const [name, s] of Object.entries(summary)) {
    for (const f of s.failures) {
      console.log(`\n✖ ${name}`);
      if (f.error) console.log(`  error: ${f.error}`);
      for (const line of f.failed) console.log(`  ${line}`);
      if (f.calls.length) console.log(`  calls: ${f.calls.join(', ')}`);
      console.log(`  answer: ${f.answer.replace(/\s+/g, ' ')}`);
    }
  }

  mkdirSync(RESULTS, { recursive: true });
  const record = { model: cfg.model, at: new Date().toISOString(), repeat: args.repeat, summary, results };
  const stamp = record.at.replace(/[:.]/g, '-');
  writeFileSync(join(RESULTS, `${stamp}.json`), JSON.stringify(record, null, 2));
  if (args.save) writeFileSync(join(RESULTS, `${args.save}.json`), JSON.stringify(record, null, 2));
  process.exitCode = total === 1 ? 0 : 1;
}

main().catch((err) => { console.error(err); process.exit(2); });
