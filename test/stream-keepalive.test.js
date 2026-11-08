// A run's stream can go quiet for minutes (a call waiting on approval, a slow
// tool), and proxies close one that idles past about a minute. The server
// writes a comment line on a timer, which the page's reader skips.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRuns, PING_MS } from '../src/chat/runs.ts';
import { events } from '../web/src/core/sse.ts';

function fakeResponse() {
  const res = new EventEmitter();
  res.written = [];
  res.writeHead = () => res;
  res.write = (chunk) => { res.written.push(chunk); return true; };
  res.end = () => res.emit('close');
  return res;
}

test('a watched run writes a keep-alive comment while it is quiet, and stops once the viewer goes', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const runs = createRuns({ store: {} });
  const run = { events: [{ type: 'chat', id: 'c' }], subs: new Set(), done: false };
  const res = fakeResponse();
  runs.attach(run, res, 0);
  assert.equal(res.written.length, 1, 'the backlog first');
  t.mock.timers.tick(PING_MS);
  t.mock.timers.tick(PING_MS);
  assert.deepEqual(res.written.slice(1), [': ping\n\n', ': ping\n\n']);
  res.emit('close');
  t.mock.timers.tick(PING_MS * 3);
  assert.equal(res.written.length, 3, 'no writes after close');
  assert.equal(run.subs.size, 0);
});

test('the page reads data frames and skips keep-alive comments', async () => {
  const body = 'data: {"type":"chat","id":"c"}\n\n: ping\n\ndata: {"type":"done"}\n\n';
  const seen = [];
  for await (const ev of events(new Response(body))) seen.push(ev.type);
  assert.deepEqual(seen, ['chat', 'done']);
});
