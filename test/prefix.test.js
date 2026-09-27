import test from 'node:test';
import assert from 'node:assert/strict';
import { prefixFingerprint } from '../src/llm.js';

const sys = { role: 'system', content: 'sys' };
const u = { role: 'user', content: 'hi' };
const a = { role: 'assistant', content: 'yo' };

test('an append matches every message of the previous request', () => {
  const first = prefixFingerprint({ messages: [sys, u] });
  assert.equal(first.matched, 0);
  assert.equal(first.previous, null);
  const next = prefixFingerprint({ messages: [sys, u, a] }, first.chain);
  assert.equal(next.matched, 2);
  assert.equal(next.previous, 2);
});

test('a rewritten message breaks the match exactly there', () => {
  const first = prefixFingerprint({ messages: [sys, u, a] });
  const next = prefixFingerprint({ messages: [sys, { ...u, content: 'changed' }, a] }, first.chain);
  assert.equal(next.matched, 1);
});

test('a changed tool block breaks the match from the start', () => {
  const first = prefixFingerprint({ messages: [sys, u], tools: [] });
  const next = prefixFingerprint({ messages: [sys, u], tools: [{ type: 'function' }] }, first.chain);
  assert.equal(next.matched, 0);
  assert.notEqual(next.tools, first.tools);
});

test('a stub first sent whole last turn marks this turn cold', async () => {
  const { swapsStubThisTurn } = await import('../src/llm.js');
  const big = 'x'.repeat(40000);
  const rows = [
    { role: 'user' },
    { role: 'tool', content: big, stub_text: 'stub' },
    { role: 'user' }
  ];
  assert.equal(swapsStubThisTurn(rows, { maxTurnChars: 120000 }), true);
  // Past the turn cap it was a stub all along: nothing changes.
  assert.equal(swapsStubThisTurn(rows, { maxTurnChars: 30000 }), false);
  assert.equal(swapsStubThisTurn([{ role: 'user' }], {}), false);
});

test('a model entry keeps the global provider data policy', async () => {
  const { effectiveConfig } = await import('../src/models.js');
  const cfg = {
    model: 'flash',
    extraBody: { provider: { zdr: true, data_collection: 'deny' } },
    models: [{ id: 'flash', model: 'm', extraBody: { provider: { order: ['Relace'] } } }]
  };
  assert.deepEqual(effectiveConfig(cfg, 'flash').extraBody.provider,
    { zdr: true, data_collection: 'deny', order: ['Relace'] });
});
