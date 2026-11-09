// The config, secrets and MCP files are replaced whole or not at all: a write
// that fails leaves the old file as it was, and no temporary file behind.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeAtomic } from '../server/config/config.ts';

test('a write replaces the file and leaves nothing beside it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atomic-'));
  const file = join(dir, 'tinywebui.config.json');
  writeFileSync(file, '{"old":true}\n');
  writeAtomic(file, '{"new":true}\n');
  assert.equal(readFileSync(file, 'utf8'), '{"new":true}\n');
  assert.deepEqual(readdirSync(dir), ['tinywebui.config.json']);
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600, 'owner only');
});

test('a write that fails leaves the old file as it was', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atomic-'));
  // A directory where the file should be: the rename over it fails.
  const target = join(dir, 'secrets.json');
  mkdirSync(target);
  writeFileSync(join(target, 'keep'), 'x');
  assert.throws(() => writeAtomic(target, '{}'));
  assert.ok(statSync(target).isDirectory(), 'the original is untouched');
  assert.deepEqual(readdirSync(dir), ['secrets.json'], 'no temporary file is left behind');
});
