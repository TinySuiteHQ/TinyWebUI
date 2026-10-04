import test from 'node:test';
import assert from 'node:assert/strict';

import { repairToolHistory, UNKNOWN_OUTCOME } from '../src/harness/history.js';

const call = (id) => ({ id, type: 'function', function: { name: 'x', arguments: '{}' } });

test('valid history comes back as the same array', () => {
  const h = [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: null, tool_calls: [call('a'), call('b')] },
    { role: 'tool', tool_call_id: 'b', content: '2' },
    { role: 'tool', tool_call_id: 'a', content: '1' },
    { role: 'assistant', content: 'done' }
  ];
  assert.equal(repairToolHistory(h), h);
});

test('unanswered calls get an unknown-outcome result right after their batch', () => {
  const h = [
    { role: 'assistant', content: null, tool_calls: [call('a'), call('b')] },
    { role: 'tool', tool_call_id: 'a', content: '1' },
    { role: 'user', content: 'next' },
    { role: 'assistant', content: null, tool_calls: [call('c')] }
  ];
  const out = repairToolHistory(h);
  assert.deepEqual(out.map((m) => m.role === 'tool' ? `tool:${m.tool_call_id}` : m.role),
    ['assistant', 'tool:a', 'tool:b', 'user', 'assistant', 'tool:c']);
  assert.equal(out[2].content, UNKNOWN_OUTCOME);
  assert.equal(h.length, 4, 'input untouched');
});

test('results without their call are dropped, not fatal', () => {
  const out = repairToolHistory([
    { role: 'tool', tool_call_id: 'gone', content: 'x' },
    { role: 'user', content: 'q' },
    { role: 'assistant', content: null, tool_calls: [call('a')] },
    { role: 'tool', tool_call_id: 'a', content: '1' },
    { role: 'tool', tool_call_id: 'a', content: 'dup' }
  ]);
  assert.deepEqual(out.map((m) => m.content), ['q', null, '1']);
});
