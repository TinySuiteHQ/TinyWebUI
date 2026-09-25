// The generic loop on its own: a scripted model and fake tools, with no HTTP
// server, provider or SQLite store anywhere in sight.
import test from 'node:test';
import assert from 'node:assert/strict';

import { runAgentLoop } from '../src/agent.js';

const call = (id, name) => ({ id, type: 'function', function: { name, arguments: '{}' } });

/** A runtime that plays back one assistant message per model call and records what it saw. */
function scripted(replies, extra = {}) {
  const turns = [];
  const batches = [];
  const events = [];
  return {
    turns, batches, events,
    runtime: {
      onEvent: (e) => events.push(e),
      streamTurn: async ({ messages, round, lastCall }) => {
        turns.push({ round, lastCall, messages: messages.map((m) => m.role) });
        return structuredClone(replies[Math.min(turns.length - 1, replies.length - 1)]);
      },
      executeToolBatch: async (calls, { round }) => {
        batches.push({ round, ids: calls.map((c) => c.id) });
        return calls.map((c) => {
          const m = { role: 'tool', tool_call_id: c.id, content: `result of ${c.function.name}` };
          return { wire: m, message: m };
        });
      },
      ...extra
    }
  };
}

test('the loop feeds tool results back and stops when the model answers', async () => {
  const s = scripted([
    { role: 'assistant', content: null, tool_calls: [call('a', 'search'), call('b', 'read')] },
    { role: 'assistant', content: 'done' }
  ]);
  const out = await runAgentLoop({ messages: [{ role: 'user', content: 'go' }], maxRounds: 5, runtime: s.runtime });

  assert.deepEqual(out.map((m) => m.role), ['assistant', 'tool', 'tool', 'assistant']);
  assert.deepEqual(out.slice(1, 3).map((m) => m.tool_call_id), ['a', 'b'], 'results keep call order');
  assert.deepEqual(s.batches, [{ round: 0, ids: ['a', 'b'] }], 'one response is one batch and one round');
  assert.deepEqual(s.turns[1].messages, ['user', 'assistant', 'tool', 'tool']);
});

test('the budget ends in a final tool-less pass, and stray calls on it are dropped', async () => {
  const s = scripted([{ role: 'assistant', content: 'more', tool_calls: [call('x', 'search')] }]);
  const out = await runAgentLoop({ messages: [], maxRounds: 2, runtime: s.runtime });

  assert.deepEqual(s.turns.map((t) => t.lastCall), [false, false, true]);
  assert.equal(s.batches.length, 2);
  assert.equal(out.at(-1).tool_calls, undefined, 'no call is left without a result');
  assert.ok(s.events.some((e) => e.type === 'notice' && /Tool budget spent/.test(e.text)));
});

test('shouldContinue can stop the run at the boundary after a tool batch', async () => {
  const s = scripted([{ role: 'assistant', content: null, tool_calls: [call('x', 'search')] }], {
    shouldContinue: async ({ round }) => round < 1
  });
  const out = await runAgentLoop({ messages: [], maxRounds: 10, runtime: s.runtime });

  assert.equal(s.turns.length, 2);
  assert.equal(out.at(-1).role, 'tool', 'stopped after results, never mid-batch');
});

test('the wire copy of a result goes to the model, the message copy to the caller', async () => {
  const s = scripted([
    { role: 'assistant', content: null, tool_calls: [call('x', 'search')] },
    { role: 'assistant', content: 'ok' }
  ]);
  s.runtime.executeToolBatch = async () => [{
    wire: { role: 'tool', tool_call_id: 'x', content: 'stub' },
    message: { role: 'tool', tool_call_id: 'x', content: 'full', compacted: true }
  }];
  let seen;
  const stream = s.runtime.streamTurn;
  s.runtime.streamTurn = async (args) => { seen = args.messages.at(-1); return stream(args); };
  const out = await runAgentLoop({ messages: [], maxRounds: 3, runtime: s.runtime });

  assert.equal(seen.content, 'stub');
  assert.equal(out[1].content, 'full');
});

test('pending input lands after a tool batch, and keeps a run going past an answer', async () => {
  const s = scripted([
    { role: 'assistant', content: null, tool_calls: [call('a', 'search')] },
    { role: 'assistant', content: 'first answer' },
    { role: 'assistant', content: 'second answer' }
  ]);
  const queue = [['after tools'], ['after answer'], []];
  s.runtime.pendingInput = async () => (queue.shift() || []).map((content) => {
    const m = { role: 'user', content };
    return { wire: m, message: m };
  });
  const out = await runAgentLoop({ messages: [], maxRounds: 5, runtime: s.runtime });

  assert.deepEqual(out.map((m) => m.content ?? m.role), [
    'assistant', 'result of search', 'after tools', 'first answer', 'after answer', 'second answer'
  ]);
  assert.deepEqual(s.turns[1].messages, ['assistant', 'tool', 'user'], 'steering is in the next request');
});
