// Cache statistics: hit share over reporting providers only, saving as reported.
import test from 'node:test';
import assert from 'node:assert/strict';

import { Store, ALL_USERS } from '../src/store/index.js';

test('cache hit share ignores providers that report no cache figures; saving is only what was reported', () => {
  const store = new Store(':memory:');
  const chat = store.chats.create({ title: 't' });
  const reply = (usage) => {
    store.messages.add(chat.id, { role: 'user', content: 'q' });
    store.messages.add(chat.id, { role: 'assistant', content: 'a', usage });
  };
  reply({ prompt_tokens: 1000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 800 }, cache_discount: 0.002 });
  reply({ input_tokens: 1000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 900 });
  reply({ prompt_tokens: 5000, completion_tokens: 10 });

  const { cache } = store.usage.statistics(ALL_USERS);
  assert.equal(cache.reportedRounds, 2);
  assert.equal(cache.input, 2000, 'the silent provider is not counted as a miss');
  assert.equal(cache.cached, 800);
  assert.equal(cache.written, 900);
  assert.equal(cache.hitShare, 0.4);
  assert.equal(cache.saved, 0.002);
  assert.equal(cache.savedRounds, 1);
});

test('no cache figures at all leaves hit share and saving unknown, not zero', () => {
  const store = new Store(':memory:');
  const chat = store.chats.create({ title: 't' });
  store.messages.add(chat.id, { role: 'user', content: 'q' });
  store.messages.add(chat.id, { role: 'assistant', content: 'a', usage: { prompt_tokens: 10, completion_tokens: 1 } });
  const { cache } = store.usage.statistics(ALL_USERS);
  assert.equal(cache.hitShare, null);
  assert.equal(cache.saved, null);
});

test('each cache miss gets one cause, and rounds with nothing to compare are not judged', () => {
  const store = new Store(':memory:');
  const chat = store.chats.create({ title: 't' });
  const t0 = Date.now();
  // created_at is set on insert; rewrite it so the idle gap is under test control.
  const reply = (usage, at) => {
    store.messages.add(chat.id, { role: 'user', content: 'q' });
    const seq = store.messages.add(chat.id, { role: 'assistant', content: 'a', usage });
    store.db.prepare('UPDATE messages SET created_at = ? WHERE chat_id = ? AND seq = ?').run(at, chat.id, seq);
  };
  const u = (cached, prefix, provider = 'A') =>
    ({ prompt_tokens: 1000, completion_tokens: 1, prompt_tokens_details: { cached_tokens: cached }, prefix, provider });
  reply(u(0, { matched: 0, previous: null }), t0);                       // first: not judged
  reply(u(900, { matched: 2, previous: 2 }), t0 + 1000);                 // hit
  reply(u(0, { matched: 1, previous: 4 }), t0 + 2000);                   // we changed the prefix
  reply(u(0, { matched: 3, previous: 5, stubSwap: true }), t0 + 2500);   // a result went to its stub, as planned
  reply(u(0, { matched: 6, previous: 6 }, 'B'), t0 + 3000);              // other upstream
  reply(u(0, { matched: 8, previous: 8 }, 'B'), t0 + 3000 + 10 * 60e3);  // idle too long
  reply(u(0, { matched: 10, previous: 10 }, 'B'), t0 + 3000 + 11 * 60e3);// no excuse
  reply(u(0, { matched: 0, previous: null }, 'B'), t0 + 3000 + 12 * 60e3); // after restart: not judged

  const { cache } = store.usage.statistics(ALL_USERS);
  assert.equal(cache.judged, 6);
  assert.deepEqual(cache.misses, { prefix: 1, switch: 1, expired: 1, stub: 1, provider: 1 });
});

test('the cache saving is worked out from charged input cost when the provider does not report it', () => {
  const store = new Store(':memory:');
  const chat = store.chats.create({ title: 't' });
  const full = 0.3e-6, cached = 0.006e-6;
  for (const [inTok, hit] of [[7000, 0], [11000, 7800], [17000, 11600]]) {
    const inputCost = (inTok - hit) * full + hit * cached;
    store.messages.add(chat.id, { role: 'user', content: 'q' });
    store.messages.add(chat.id, { role: 'assistant', content: 'a', model: 'm', usage: {
      prompt_tokens: inTok, completion_tokens: 10, prompt_tokens_details: { cached_tokens: hit },
      cost: inputCost + 1e-5, cost_details: { upstream_inference_prompt_cost: inputCost }, provider: 'P' } });
  }
  const { cache } = store.usage.statistics(ALL_USERS);
  const saved = (7800 + 11600) * (full - cached);
  assert.ok(Math.abs(cache.saved - saved) < 1e-12, `${cache.saved} vs ${saved}`);
  assert.equal(cache.rates.length, 1);
  assert.ok(cache.savedShare > 0 && cache.savedShare < 1);
});

test('no saving is claimed when one price cannot explain every request', () => {
  const store = new Store(':memory:');
  const chat = store.chats.create({ title: 't' });
  for (const [inTok, hit, inputCost] of [[1000, 0, 3e-4], [1000, 500, 1.5e-4], [1000, 900, 2.9e-4]]) {
    store.messages.add(chat.id, { role: 'user', content: 'q' });
    store.messages.add(chat.id, { role: 'assistant', content: 'a', usage: {
      prompt_tokens: inTok, completion_tokens: 1, prompt_tokens_details: { cached_tokens: hit },
      cost: inputCost, cost_details: { upstream_inference_prompt_cost: inputCost } } });
  }
  assert.equal(store.usage.statistics(ALL_USERS).cache.saved, null);
});

test('statistics narrow to a model, or to one upstream of it, and list both as choices', () => {
  const store = new Store(':memory:');
  const chat = store.chats.create({ title: 't' });
  const reply = (model, provider, cost) => {
    store.messages.add(chat.id, { role: 'user', content: 'q' });
    store.messages.add(chat.id, { role: 'assistant', content: 'a', model, usage: { prompt_tokens: 10, completion_tokens: 1, cost, provider } });
  };
  reply('m1', 'A', 1); reply('m1', 'B', 2); reply('m2', 'A', 4);

  const all = store.usage.statistics(ALL_USERS);
  assert.equal(all.reportedCost, 7);
  assert.deepEqual(all.targets, [{ model: 'm1', providers: ['A', 'B'] }, { model: 'm2', providers: ['A'] }]);
  assert.equal(store.usage.statistics(ALL_USERS, { model: 'm1' }).reportedCost, 3);
  const one = store.usage.statistics(ALL_USERS, { model: 'm1', provider: 'B' });
  assert.equal(one.reportedCost, 2);
  assert.equal(one.completedAnswers, 1);
  assert.deepEqual(one.targets, all.targets, 'the choices do not shrink with the filter');
  const days = store.usage.rollup(ALL_USERS, { model: 'm1', provider: 'A' });
  assert.equal(days.reduce((n, d) => n + d.in, 0), 10);
});
