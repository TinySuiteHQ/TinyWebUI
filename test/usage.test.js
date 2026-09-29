// One reader of provider usage for the page and the server (public/shared/usage.js),
// so a turn's usage line and the Statistics panel agree on cache hits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inputTokens, outputTokens, cacheReads, cacheWrites, tally } from '../public/shared/usage.js';

test('cache reads are found under every provider spelling', () => {
  assert.equal(cacheReads({ prompt_tokens_details: { cached_tokens: 5 } }), 5); // OpenAI chat
  assert.equal(cacheReads({ input_tokens_details: { cached_tokens: 6 } }), 6); // OpenAI Responses
  assert.equal(cacheReads({ cache_read_input_tokens: 7 }), 7); // Anthropic
  assert.equal(cacheReads({ prompt_cache_hit_tokens: 8 }), 8); // DeepSeek
  assert.equal(cacheReads({ cached_tokens: 9 }), 9);
});

test('"not reported" is null, not zero', () => {
  assert.equal(cacheReads({ prompt_tokens: 10 }), null);
  assert.equal(cacheWrites({}), null);
  assert.equal(inputTokens(null), null);
  assert.equal(cacheReads({ cache_read_input_tokens: 0 }), 0);
  assert.equal(inputTokens({ prompt_tokens: 'junk' }), null);
});

test('input and output accept both naming schemes', () => {
  assert.equal(inputTokens({ input_tokens: 3 }), 3);
  assert.equal(outputTokens({ completion_tokens: 4 }), 4);
});

test('tally sums rounds and tells "zero" from "unreported"', () => {
  const t = tally([
    { prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 40, provider: 'a' },
    { input_tokens: 50, output_tokens: 5, cache_creation_input_tokens: 20, provider: 'b' }
  ]);
  assert.deepEqual([t.in, t.out, t.cached, t.written, t.providers], [150, 15, 40, 20, ['a', 'b']]);
  assert.equal(t.reported, true);
  assert.equal(tally([{ prompt_tokens: 1, completion_tokens: 1 }]).reported, false);
});
