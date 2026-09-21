// A rate-limited provider should cost a pause, not the turn.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/store.js';
import { runChat } from '../src/llm.js';

/** A provider that fails `failures` times with `status`, then answers. */
function flaky({ failures, status, retryAfter }) {
  const seen = [];
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push(JSON.parse(body));
      if (seen.length <= failures) {
        res.writeHead(status, {
          'content-type': 'application/json',
          ...(retryAfter ? { 'retry-after': retryAfter } : {})
        });
        return res.end(JSON.stringify({ error: { message: 'temporarily rate-limited upstream' } }));
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'recovered' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    });
  });
  return { srv, seen };
}

async function listen(srv) {
  const port = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
  return `http://127.0.0.1:${port}/v1`;
}

function freshStore() {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'retry-')), 'r.db'));
  const chat = store.createChat({ title: 't' });
  store.addMessage(chat.id, { role: 'user', content: 'hi' });
  return { store, chatId: chat.id };
}

/** Mirrors what the server does: a throw from runChat becomes an error event. */
async function run(cfg, chatId, store) {
  const events = [];
  try {
    await runChat({
      cfg, chatId, store, tools: [], hub: null,
      emit: (ev) => events.push(ev),
      signal: new AbortController().signal
    });
  } catch (err) {
    events.push({ type: 'error', error: err.message });
  }
  return events;
}

test('a 429 is waited out, not fatal', async () => {
  const { srv, seen } = flaky({ failures: 2, status: 429, retryAfter: '0' });
  const baseUrl = await listen(srv);
  const { store, chatId } = freshStore();

  const events = await run(
    { baseUrl, apiKey: 'k', model: 'm', systemPrompt: 'sys', maxToolRounds: 1 },
    chatId, store
  );

  assert.equal(seen.length, 3, 'two refusals then the real answer');
  const text = events.filter((e) => e.type === 'text').map((e) => e.delta).join('');
  assert.equal(text, 'recovered');
  const notices = events.filter((e) => e.type === 'notice').map((e) => e.text);
  assert.equal(notices.length, 2);
  assert.match(notices[0], /429/);
  assert.match(notices[0], /retrying in/);
  assert.equal(events.some((e) => e.type === 'error'), false, 'the turn never errored');
  srv.close();
});

test('a pinned provider is released only after the retries are spent', async () => {
  // Never recovers, so every attempt is used.
  const { srv, seen } = flaky({ failures: 99, status: 429, retryAfter: '0' });
  const baseUrl = await listen(srv);
  const { store, chatId } = freshStore();

  const events = await run(
    {
      baseUrl: baseUrl.replace('127.0.0.1', 'localhost'),
      apiKey: 'k',
      model: 'm',
      systemPrompt: 'sys',
      maxToolRounds: 1,
      extraBody: { provider: { order: ['Fireworks'], allow_fallbacks: false } }
    },
    chatId, store
  );

  // Two refusals are taken on the pin; after that the cache stops being worth
  // waiting for and the remaining attempts go wherever they can be served.
  const held = seen.filter((b) => b.provider.allow_fallbacks === false).length;
  const released = seen.filter((b) => b.provider.allow_fallbacks === true).length;
  assert.equal(held, 3, 'the pin holds for the first two refusals');
  assert.ok(released >= 1, 'and is released for the attempts after that');
  assert.equal(held + released, seen.length);

  const notices = events.filter((e) => e.type === 'notice').map((e) => e.text);
  assert.ok(notices.some((n) => /releasing the provider pin/.test(n)));
  assert.ok(events.some((e) => e.type === 'error'), 'and it still reports failure when that fails too');
  srv.close();
});

test('a 400 is not retried', async () => {
  const { srv, seen } = flaky({ failures: 99, status: 400 });
  const baseUrl = await listen(srv);
  const { store, chatId } = freshStore();

  const events = await run(
    { baseUrl, apiKey: 'k', model: 'm', systemPrompt: 'sys', maxToolRounds: 1 },
    chatId, store
  );

  assert.equal(seen.length, 1, 'a bad request is not going to get better');
  assert.ok(events.some((e) => e.type === 'error'));
  srv.close();
});
