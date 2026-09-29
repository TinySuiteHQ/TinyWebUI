import { EVENT } from '../../public/shared/events.js';
/**
 * The generic agent loop: stream a model turn, run the tool calls it made,
 * feed the results back, repeat until the model answers or the budget is spent.
 *
 * It knows nothing about storage, approvals, MCP or caching. Those arrive
 * through `runtime`, which is what lets the loop run against a scripted model
 * and fake tools in a test:
 *
 *   streamTurn({ messages, round, lastCall, signal }) -> assistant message
 *     One model request over `messages`. On the last call the runtime must
 *     refuse tools; any calls it returns anyway are dropped here.
 *   executeToolBatch(calls, { messages, round, lastCall, signal }) -> results
 *     Runs one assistant message's calls. Each result is `{ wire, message }`:
 *     `wire` goes back to the model, `message` is what the caller is handed.
 *     They differ when a result is stubbed for later turns but not this one.
 *   onEvent(event)  -- optional; UI events the loop itself raises.
 *   shouldContinue({ round, assistant, results }) -> boolean
 *     Optional; asked after each tool batch, before the next model call. A
 *     false ends the run at that safe boundary, with the transcript valid.
 *   pendingInput({ round }) -> [{ wire, message }]
 *     Optional; user input that arrived while the run was working (steering).
 *     Asked at each safe boundary -- after a tool batch, or when the model
 *     answers -- and appended before the next model call. Input delivered on
 *     an answer keeps the run going, so the model sees it in the same run.
 *
 * Returns the messages appended during the run, in transcript order.
 */
export async function runAgentLoop({ messages, maxRounds, runtime, signal }) {
  const working = [...messages];
  const appended = [];
  const emit = runtime.onEvent || (() => {});

  // One extra pass past the budget: tools are mechanically refused there, so the
  // model spends it writing an answer instead of leaving the turn unfinished.
  for (let round = 0; round <= maxRounds; round++) {
    const lastCall = round === maxRounds;
    if (lastCall) {
      emit({
        type: EVENT.NOTICE,
        text: `Tool budget spent (${maxRounds} rounds) — answering with what was gathered.`
      });
    }

    const assistant = await runtime.streamTurn({ messages: working, round, lastCall, signal });
    // A provider that ignores tool_choice could still emit calls here. Dropping
    // them keeps history valid, since nothing will produce their results.
    if (lastCall) delete assistant.tool_calls;
    working.push(assistant);
    appended.push(assistant);

    const take = async () => {
      const input = (await runtime.pendingInput?.({ round })) || [];
      for (const { wire, message } of input) {
        working.push(wire);
        appended.push(message);
      }
      return input.length > 0;
    };

    const calls = assistant.tool_calls || [];
    // The last pass takes no input: nothing would answer it. It stays queued.
    if (lastCall) return appended;
    if (!calls.length) {
      if (await take()) continue;
      return appended;
    }

    const results = await runtime.executeToolBatch(calls, { messages: working, round, lastCall, signal });
    for (const { wire, message } of results) {
      working.push(wire);
      appended.push(message);
    }

    if (runtime.shouldContinue && !(await runtime.shouldContinue({ round, assistant, results }))) {
      return appended;
    }
    await take();
  }
  return appended;
}

/**
 * Lifecycle hooks: small internal seams at the tool and turn boundaries, so
 * cross-cutting policy (approvals, audit, result shaping, stopping early)
 * stays out of the loop. Not a plugin system; nothing outside this repo
 * registers them and the shapes carry no compatibility promise.
 *
 *   beforeToolCall({ name, args, call, round, signal })
 *     -> undefined to let the call through, or { block: text } to refuse it,
 *        with `text` as the result the model sees. The first block wins and
 *        later hooks do not run. Arguments are read-only here.
 *   afterToolCall({ name, args, call, round, result, signal })
 *     -> undefined, { result } to replace what is persisted and sent back,
 *        and/or { stop: true } to end the run once this batch is done.
 *        Each hook sees the result as the previous one left it.
 *   afterTurn({ round, assistant, results, signal })
 *     -> undefined or { stop: true }: end before the next model call.
 *
 * Hooks of one kind run in array order, one at a time, each awaited, with
 * the run's AbortSignal checked around every one. `each(out)` sees each
 * non-empty output and returns true to stop the chain. A throw is never
 * swallowed here; the caller turns it into a visible outcome.
 */
export async function runHooks(list, ctx, each = () => false) {
  for (const hook of list || []) {
    if (ctx.signal?.aborted) throw new Error('Stopped.');
    const out = await hook(ctx);
    if (ctx.signal?.aborted) throw new Error('Stopped.');
    if (out && each(out)) return true;
  }
  return false;
}
