// The server is TypeScript that Node runs as is. A .js file in src/ or bin/
// is either build output beside its .ts (npm run build, gitignored) or code
// that skipped the type check -- and that .gitignore would quietly keep out
// of every commit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('src/ and bin/ hold no JavaScript of their own', () => {
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.js') ? [join(d, e.name)] : []);
  const orphans = ['src', 'bin'].flatMap((d) => walk(join(ROOT, d)))
    .filter((f) => !existsSync(f.replace(/\.js$/, '.ts')))
    .map((f) => f.slice(ROOT.length));
  assert.deepEqual(orphans, [], 'write these in TypeScript');
});
