// The stream events are one list shared by server and page (public/shared/events.js):
// the page must handle every one, and the server must not emit a bare string.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { EVENT } from '../public/shared/events.js';

test('the page handles every stream event', () => {
  const page = readFileSync(new URL('../public/stream.js', import.meta.url), 'utf8');
  for (const key of Object.keys(EVENT)) assert.ok(page.includes(`EVENT.${key}`), `stream.js does not handle EVENT.${key}`);
});

test('the server emits events only by name', () => {
  const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : []; });
  for (const file of walk(new URL('../src', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
    const src = readFileSync(file, 'utf8');
    assert.doesNotMatch(src, /emit\??\.?\(\{\s*type:\s*'/, `${file} emits an event as a bare string`);
  }
});
