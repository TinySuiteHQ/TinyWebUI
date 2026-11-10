// Compression: large JSON replies and the page's own files go out brotli or
// gzip when the client takes it, and exactly as they are when it does not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { json, serveStatic, pageBuilt, PAGE_DIR } from '../server/http.ts';

const big = { rows: Array.from({ length: 400 }, (_, i) => ({ i, text: `row ${i} of a long chat, said again and again` })) };
const small = { ok: true };

const srv = createServer((req, res) => {
  if (req.url === '/big') return json(res, 200, big);
  if (req.url === '/small') return json(res, 200, small);
  return serveStatic(req, res);
});
const port = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

/** A raw request, so nothing decompresses behind the test's back. */
const get = (path, headers = {}) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
    const parts = [];
    res.on('data', (d) => parts.push(d));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
  });
  req.on('error', reject);
  req.end();
});

test('a large JSON reply is compressed for a client that takes it, and decodes to the same thing', async () => {
  const br = await get('/big', { 'accept-encoding': 'gzip, deflate, br' });
  assert.equal(br.headers['content-encoding'], 'br');
  assert.equal(br.headers.vary, 'accept-encoding');
  assert.equal(Number(br.headers['content-length']), br.body.length);
  assert.deepEqual(JSON.parse(brotliDecompressSync(br.body)), big);

  const gz = await get('/big', { 'accept-encoding': 'gzip' });
  assert.equal(gz.headers['content-encoding'], 'gzip');
  assert.deepEqual(JSON.parse(gunzipSync(gz.body)), big);

  const plain = await get('/big');
  assert.equal(plain.headers['content-encoding'], undefined, 'no Accept-Encoding: sent as is');
  assert.deepEqual(JSON.parse(plain.body), big);
  assert.ok(br.body.length < plain.body.length / 4, `compressed ${br.body.length} of ${plain.body.length} bytes`);
});

test('a small reply is never compressed', async () => {
  const r = await get('/small', { 'accept-encoding': 'br' });
  assert.equal(r.headers['content-encoding'], undefined);
  assert.deepEqual(JSON.parse(r.body), small);
});

test("the page's files go out compressed, each encoding with its own ETag", { skip: !pageBuilt() && 'the page is not built' }, async () => {
  const js = readdirSync(join(PAGE_DIR, 'assets')).find((n) => n.endsWith('.js'));
  const raw = readFileSync(join(PAGE_DIR, 'assets', js));
  const path = `/assets/${js}`;

  const br = await get(path, { 'accept-encoding': 'br' });
  assert.equal(br.status, 200);
  assert.equal(br.headers['content-encoding'], 'br');
  assert.match(br.headers.etag, /-br"$/);
  assert.ok(brotliDecompressSync(br.body).equals(raw), 'decodes to the file on disk');
  assert.match(br.headers['cache-control'], /immutable/);

  const again = await get(path, { 'accept-encoding': 'br', 'if-none-match': br.headers.etag });
  assert.equal(again.status, 304, 'an unchanged file revalidates');

  const gz = await get(path, { 'accept-encoding': 'gzip' });
  assert.equal(gz.headers['content-encoding'], 'gzip');
  assert.notEqual(gz.headers.etag, br.headers.etag);
  assert.ok(gunzipSync(gz.body).equals(raw));

  const plain = await get(path);
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.ok(plain.body.equals(raw));
  assert.equal((await get(path, { 'if-none-match': br.headers.etag })).status, 200, "the brotli ETag does not stand for the plain file");
});

test.after(() => srv.close());
