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
        type: 'notice',
        text: `Tool budget spent (${maxRounds} rounds) — answering with what was gathered.`
      });
    }

    const assistant = await runtime.streamTurn({ messages: working, round, lastCall, signal });
    // A provider that ignores tool_choice could still emit calls here. Dropping
    // them keeps history valid, since nothing will produce their results.
    if (lastCall) delete assistant.tool_calls;
    working.push(assistant);
    appended.push(assistant);

    const calls = assistant.tool_calls || [];
    if (lastCall || !calls.length) return appended;

    const results = await runtime.executeToolBatch(calls, { messages: working, round, lastCall, signal });
    for (const { wire, message } of results) {
      working.push(wire);
      appended.push(message);
    }

    if (runtime.shouldContinue && !(await runtime.shouldContinue({ round, assistant, results }))) {
      return appended;
    }
  }
  return appended;
}
