// The page has no build step, so a syntax error ships straight to the browser
// and takes every module down with it. Nothing else here parses these files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('every page module parses', () => {
  const files = readdirSync('public', { recursive: true }).filter((f) => f.endsWith('.js'));
  assert.ok(files.length > 10);
  const bad = files.filter((f) => spawnSync(process.execPath, ['--check', join('public', f)]).status !== 0);
  assert.deepEqual(bad, []);
});
