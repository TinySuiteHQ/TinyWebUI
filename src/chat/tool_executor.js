import { toWire } from '../store/index.js';
import { approvalFor } from '../config/approval.js';
import { runHooks } from './agent.js';
import { digest } from './compact.js';
import { EVENT } from '../../public/shared/events.js';

/**
 * Key for spotting a repeated call. Keys are sorted at every depth: a flat
 * replacer list would also act as a whitelist on nested objects and collapse
 * {q:{text:"a"}} and {q:{text:"b"}} into the same key.
 */
function stableKey(value) {
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map((k) => `${JSON.stringify(k)}:${stableKey(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/**
 * TinyWebUI's tool policy, as the loop's `executeToolBatch`: argument
 * validation, duplicate suppression, approvals, MCP dispatch, artifacts and
 * stubbing. State that spans the turn (seen calls, "always allow") lives in
 * the closure, so one executor serves exactly one turn.
 */
export function toolExecutor({ cfg, chatId, store, hub, emit, unattended, approve, askUser, footer: roundFooter, hooks, signal }) {
  const toolCtx = { store, chatId, budget: cfg.expandCharBudget || 8000, unattended, askUser: unattended ? null : askUser };
  // Same tool name + same args, seen earlier in this turn, on a tool that has
  // declared its result depends only on its arguments: re-running it only burns
  // a round. Tracked by round so the model can be told exactly when it already
  // did this. Anything else -- a browser snapshot after a click, a list after a
  // create -- is run again, because its answer may well have changed.
  const seenCalls = new Map();
  // "Always allow" is saved by the server, but this turn's cfg is a snapshot
  // taken before it; remembered here so the next call in the turn doesn't ask.
  const allowedNow = new Set();

  // Set by an afterToolCall hook; honoured once the batch is complete.
  let stop = false;

  /** Resolves one call against the approval policy: 'allow', 'deny' or 'unattended'. */
  const gate = async (name, args, id) => {
    if (allowedNow.has(name) || approvalFor(cfg, hub, name, args) === 'auto') return 'allow';
    if (unattended) return 'unattended';
    if (!approve) return 'deny';
    emit({ type: EVENT.APPROVAL, id, name, args });
    const decision = await approve({ id, name, args });
    emit({ type: EVENT.APPROVAL_DONE, id, name, decision });
    if (decision === 'always') allowedNow.add(name);
    return decision === 'always' || decision === 'allow' ? 'allow' : 'deny';
  };

  const STOPPED = 'Error: the run was stopped before this call finished.';

  /** Approval, as the first beforeToolCall hook. */
  const approval = async ({ name, args, call }) => {
    const decision = await gate(name, args, call.id);
    if (decision === 'unattended') {
      return {
        block: `Error: "${name}" needs the user's approval before it runs, and this is an`
          + ' unattended scheduled run with no one to ask, so it was not called. Finish what'
          + ' you can without it and say in your result that it still needs doing.'
      };
    }
    if (decision === 'deny') {
      return {
        block: `The user declined this call to "${name}", so it was not run. Do not retry it`
          + ' unless they ask; continue without it, or ask them how they would like to proceed.'
      };
    }
    return undefined;
  };
  const before = [approval, ...(hooks.beforeToolCall || [])];

  /** Runs the afterToolCall chain; a failing hook leaves the result as it stood. */
  const after = async (ctx) => {
    try {
      await runHooks(hooks.afterToolCall, ctx, (o) => {
        if (o.result !== undefined) ctx.result = o.result;
        if (o.stop) stop = true;
        return false;
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      emit({ type: EVENT.NOTICE, text: `Tool result hook failed for "${ctx.name}" (${err.message}); result kept as returned.` });
    }
    return ctx.result;
  };

  /**
   * Everything that has to happen before a call may run: argument checks,
   * duplicate suppression and the beforeToolCall chain (approval included).
   * Returns `{ args, result }` for a call that will not run, `{ args, run }`
   * for one that will.
   */
  const prepare = async (call, round) => {
    const name = call.function.name;
    let args = {};
    let badArgs = null;
    try { args = call.function.arguments ? JSON.parse(call.function.arguments) : {}; }
    catch (err) { badArgs = err.message; }
    if (!badArgs && (args === null || typeof args !== 'object' || Array.isArray(args))) {
      badArgs = 'arguments must be a JSON object';
    }
    emit({ type: EVENT.TOOL_CALL, id: call.id, name, args: badArgs ? {} : args });

    if (badArgs) {
      // Never run a tool on arguments the model did not write. Falling back
      // to {} quietly runs it on its defaults, and the model then reasons as
      // if its own arguments had been used.
      return {
        args: {},
        result: `Error: the arguments for "${name}" were not valid JSON (${badArgs}), so the`
          + ' tool was not called. Retry with a well-formed JSON object.'
      };
    }
    const dupKey = `${name}:${stableKey(args)}`;
    const seenRound = hub.isIdempotent?.(name) ? seenCalls.get(dupKey) : undefined;
    if (seenRound !== undefined) {
      return {
        args,
        result: `Skipped: this is an identical call to "${name}" with the same arguments`
          + ` already made in round ${seenRound + 1} of this turn, and this tool returns the same`
          + ' result for the same arguments. Reuse what you got back then.'
      };
    }
    const ctx = { name, args, call, round, signal };
    let blocked = null;
    try {
      await runHooks(before, ctx, (o) => {
        if (o.block === undefined) return false;
        blocked = String(o.block);
        return true;
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      // A policy check that cannot decide must not let the call through.
      emit({ type: EVENT.NOTICE, text: `Tool policy hook failed for "${name}" (${err.message}); call not run.` });
      blocked = `Error: a policy check for "${name}" failed (${err.message}), so the tool was not`
        + ' called. Continue without it.';
    }
    if (blocked !== null) return { args, result: blocked };
    seenCalls.set(dupKey, round);
    return { args, run: ctx };
  };

  /**
   * Runs one prepared call and its afterToolCall chain. A stop abandons it
   * rather than waiting on a tool that may never answer; the call still gets
   * a result, so the transcript stays valid.
   */
  const run = async (ctx) => {
    if (signal?.aborted) return STOPPED;
    let onAbort;
    const stopped = new Promise((r) => {
      onAbort = () => r(STOPPED);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const result = await Promise.race([hub.call(ctx.name, ctx.args, toolCtx), stopped]);
      if (result === STOPPED) return result;
      return await after({ ...ctx, result });
    } catch (err) {
      if (signal?.aborted) return STOPPED;
      throw err;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  };

  const execute = async (calls, { round }) => {
    // Every call is checked and approved before any of them runs, so no
    // write can start while a later call in the batch still waits on the user.
    const prepared = [];
    for (const call of calls) {
      try {
        prepared.push(signal?.aborted ? { args: {}, result: STOPPED } : await prepare(call, round));
      } catch (err) {
        if (!signal?.aborted) throw err;
        // The assistant call is already durable. Close every result slot even
        // when Stop interrupts an approval rather than a running tool.
        prepared.push({ args: {}, result: STOPPED });
      }
    }

    // One sequential call makes the whole batch sequential: deterministic, and
    // no guessing at which calls could safely overlap it.
    const parallel = prepared.every((p) => !p.run || hub.executionMode?.(p.run.name) === 'parallel');
    const finish = async (p, call) => {
      if (p.run) p.result = await run(p.run);
      emit({ type: EVENT.TOOL_RESULT, id: call.id, name: call.function.name, result: p.result });
    };
    if (parallel) await Promise.all(prepared.map((p, i) => finish(p, calls[i])));
    else for (const [i, p] of prepared.entries()) await finish(p, calls[i]);

    // Persisted in the order the model made the calls, whatever order they finished in.
    const out = [];
    for (const [i, call] of calls.entries()) {
      const name = call.function.name;
      const { args, result } = prepared[i];

      const text = String(result);
      // Every tool result becomes an artifact, whatever tool produced it. This
      // is the one thing that makes compaction possible later: content can only
      // leave the window safely if the stub left behind can bring it back. The
      // artifact keeps the raw output; the budget footer is harness chatter.
      const artifactId = store.messages.addArtifact(chatId, { toolName: name, args, content: text });
      const footer = i === calls.length - 1 ? roundFooter(round) : '';
      const msg = { role: 'tool', tool_call_id: call.id, content: text + footer, artifact_id: artifactId };

      // Two caps. Past `maxInlineChars` a result is stubbed for every LATER
      // turn: the round that asked for it still reads it whole, since a head and
      // a tail leave no way to aim a grep at the middle and blind paging costs
      // more rounds than the inline text ever cost in tokens. Past
      // `maxTurnChars` it is stubbed even for this turn, because a result that
      // size would be resent in full on every remaining round and can blow the
      // window on its own. The turn cap is an append and costs no cache. The
      // inline cap is not: the next turn swaps full text for the stub, which
      // is a rewrite -- runChat opens any due epoch on that same turn so the
      // conversation pays for one cold request, not two.
      const inlineCap = cfg.maxInlineChars || 0;
      const turnCap = cfg.maxTurnChars || 0;
      const overTurn = turnCap > 0 && text.length > turnCap;
      if (overTurn || (inlineCap > 0 && text.length > inlineCap)) {
        msg.stub_text = digest({ id: artifactId, tool_name: name, content: text }) + (overTurn ? footer : '');
      }

      store.messages.add(chatId, msg);
      out.push({
        wire: toWire(overTurn ? msg : { ...msg, stub_text: null }),
        message: msg.stub_text ? { ...msg, compacted: true } : msg
      });
    }
    return out;
  };

  return { execute, stopRequested: () => stop };
}
