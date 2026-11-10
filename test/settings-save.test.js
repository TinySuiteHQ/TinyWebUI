// Saving settings sends only what this page changed, so another admin's (or
// the config file's) changes to other keys survive; a key both changed is a
// clash the page names before overwriting it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { changedPatch, keyWords } from '../web/src/panels/settings/draft.ts';

const base = { systemPrompt: 'Be helpful.', temperature: null, keepTurns: 2, timezone: '' };

test('only the keys this page changed are sent', () => {
  const next = { ...base, keepTurns: 4 };
  const latest = { ...base, timezone: 'Europe/Vienna' }; // someone else, meanwhile
  assert.deepEqual(changedPatch(next, base, latest), { patch: { keepTurns: 4 }, clashes: [] });
});

test('a key changed on both sides, to different values, is a clash', () => {
  const next = { ...base, systemPrompt: 'Be terse.' };
  const latest = { ...base, systemPrompt: 'Be thorough.' };
  assert.deepEqual(changedPatch(next, base, latest), { patch: { systemPrompt: 'Be terse.' }, clashes: ['systemPrompt'] });
  assert.equal(keyWords('systemPrompt'), 'system prompt');
});

test('the same change made twice is no clash', () => {
  const next = { ...base, keepTurns: 4 };
  assert.deepEqual(changedPatch(next, base, next).clashes, []);
});

test('a key the draft leaves out is kept, never cleared', () => {
  const withKey = { ...base, apiKey: 'sk-old' };
  assert.deepEqual(changedPatch(base, withKey, withKey).patch, {});
});

test('lists and objects compare by value', () => {
  const b = { ...base, models: [{ id: 'fast', enabled: true }] };
  assert.deepEqual(changedPatch(structuredClone(b), b, b).patch, {});
  const next = { ...b, models: [{ id: 'fast', enabled: false }] };
  assert.deepEqual(changedPatch(next, b, b).patch, { models: next.models });
});
