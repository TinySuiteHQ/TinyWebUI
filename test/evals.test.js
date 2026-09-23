// The eval checks must be able to fail -- a check that passes everything turns
// a pass rate into noise. These run without a model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

import { check } from '../evals/checks.js';

const run = (over = {}) => ({ answer: '', calls: [], rounds: 0, asked: [], ...over });

test('answer checks match and miss', async () => {
  assert.ok((await check({ type: 'answer_matches', pattern: '391' }, run({ answer: 'It is 391.' }), {})).ok);
  assert.ok(!(await check({ type: 'answer_matches', pattern: '391' }, run({ answer: 'About 400.' }), {})).ok);
  assert.ok(!(await check({ type: 'answer_not_matches', pattern: 'sent' }, run({ answer: 'Email sent!' }), {})).ok);
});

test('call checks count by tool and by arguments', async () => {
  const r = run({ calls: [{ name: 'weather', args: { city: 'Vienna' } }, { name: 'weather', args: { city: 'Graz' } }] });
  assert.ok((await check({ type: 'called', tool: 'weather', min: 2, max: 2 }, r, {})).ok);
  assert.ok(!(await check({ type: 'called', tool: 'weather', max: 1 }, r, {})).ok);
  assert.ok((await check({ type: 'called', tool: 'weather', args: { city: 'graz' } }, r, {})).ok);
  assert.ok(!(await check({ type: 'called', tool: 'weather', args: { city: 'linz' } }, r, {})).ok);
  assert.ok(!(await check({ type: 'not_called', tool: 'weather' }, r, {})).ok);
  assert.ok(!(await check({ type: 'max_calls', tool: '*', value: 1 }, r, {})).ok);
});

test('mentions_today accepts the usual spellings and nothing else', async () => {
  const tz = 'UTC';
  const now = new Date();
  const iso = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const long = new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'long', day: 'numeric', year: 'numeric' }).format(now);
  assert.ok((await check({ type: 'mentions_today' }, run({ answer: `Today is ${iso}.` }), { timezone: tz })).ok);
  assert.ok((await check({ type: 'mentions_today' }, run({ answer: `It's ${long}.` }), { timezone: tz })).ok);
  assert.ok(!(await check({ type: 'mentions_today' }, run({ answer: 'It is 1999-01-01.' }), { timezone: tz })).ok);
});

test('every task file parses and uses only known check types', async () => {
  const dir = new URL('../evals/tasks/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(files.length > 0);
  for (const f of files) {
    const task = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
    assert.ok(task.name && task.prompt, `${f}: name and prompt`);
    for (const c of task.checks || []) {
      if (c.type === 'judge') continue;
      const res = await check(c, run(), {});
      assert.doesNotMatch(res.detail || '', /unknown check type/, `${f}: ${c.type}`);
    }
  }
});
