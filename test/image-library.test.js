// The Files page's images: listed without their bytes, served one at a time,
// each only to the person whose chat holds it, and only as a raster type.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { trustedServer } from './trusted-helpers.js';

const { srv, as, dir, base } = await trustedServer();
test.after(() => srv.shutdown());

const alice = as({ id: 'sub-alice', email: 'alice@example.com', role: 'admin' });
const bob = as({ id: 'sub-bob', email: 'bob@example.com' });
await alice('/api/auth/me');
const bobId = (await bob('/api/auth/me')).data.user.id;
// The bytes are not JSON, so this one read builds the gateway's headers itself.
const bobHeaders = { 'x-tinysuite-user-id': 'sub-bob', 'x-tinysuite-email': 'bob@example.com' };

// A 1x1 PNG, and an SVG that must never be served from this origin.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64');

const { Store } = await import('../server/store/index.ts');
const store = new Store(join(dir, 'chats.db'));
try {
  store.chats.create({ id: 'bob-pics', title: 'Bob pictures' }, bobId);
  store.messages.add('bob-pics', { role: 'user', content: 'look', images: [
    { mime: 'image/png', data: PNG, filename: 'dot.png' },
    { mime: 'image/svg+xml', data: SVG }
  ] });
} finally { store.close(); }

test('the list names each image and its chat, without the bytes', async () => {
  const { status, data } = await bob('/api/images');
  assert.equal(status, 200);
  assert.equal(data.images.length, 2);
  const [png] = data.images;
  assert.equal(png.filename, 'dot.png');
  assert.equal(png.chatId, 'bob-pics');
  assert.equal(png.chatTitle, 'Bob pictures');
  assert.equal(png.index, 0);
  assert.equal('data' in png, false);
});

test('an image is served as stored to its owner, and to no one else', async () => {
  const [png] = (await bob('/api/images')).data.images;
  const res = await fetch(`${base}/api/images/${png.messageId}/0`, { headers: bobHeaders });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), Buffer.from(PNG, 'base64'));

  assert.equal((await alice(`/api/images/${png.messageId}/0`)).status, 404);
  assert.equal((await alice('/api/images')).data.images.length, 0);
});

test('a stored image of a type normalizing never makes is not served', async () => {
  const [png] = (await bob('/api/images')).data.images;
  assert.equal((await bob(`/api/images/${png.messageId}/1`)).status, 404);
  assert.equal((await bob(`/api/images/${png.messageId}/7`)).status, 404);
});
