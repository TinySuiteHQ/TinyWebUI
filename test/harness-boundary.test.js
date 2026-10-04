// src/harness/ is the model-facing core: request shape, the loop, history
// validity. It must stay usable without the server, so it imports nothing
// from the app -- no store, tools, MCP or config -- only its own files,
// public/shared and node built-ins.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const dir = new URL('../src/harness/', import.meta.url);

test('src/harness imports only itself, public/shared and node built-ins', () => {
  const bad = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const src = readFileSync(new URL(file, dir), 'utf8');
    for (const [, spec] of src.matchAll(/^\s*(?:import|export)[^'"]*?from\s+['"]([^'"]+)['"]/gm)) {
      if (spec.startsWith('node:') || spec.startsWith('../../public/shared/')) continue;
      if (spec.startsWith('./') && !spec.slice(2).includes('/')) continue;
      bad.push(`${file}: ${spec}`);
    }
  }
  assert.deepEqual(bad, []);
});
