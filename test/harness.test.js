// The tool loop as the model experiences it: what gets run, what gets refused,
// and what the model is told -- driven end to end against a scripted provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { Store } from '../src/store/index.js';
import { runChat } from '../src/chat/llm.js';
import { manageAutomation, runMessage } from '../src/automations/automation.js';

/** A provider that plays back one scripted reply per request and records every body. */
async function scripted(replies) {
  const seen = [];
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push(JSON.parse(body));
      const reply = replies[Math.min(seen.length - 1, replies.length - 1)];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const delta = reply.calls
        ? { tool_calls: reply.calls.map(([name, args], index) => ({
            index, id: `c${seen.length}_${index}`, type: 'function', function: { name, arguments: args }
          })) }
        : { content: reply.text };
      res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 10 } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  const port = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
  return { seen, baseUrl: `http://127.0.0.1:${port}/v1`, close: () => srv.close() };
}

function fakeHub({ idempotent = [], results = {} } = {}) {
  const calls = [];
  return {
    calls,
    isIdempotent: (name) => idempotent.includes(name),
    instructionsBlock: () => '',
    call: async (name, args) => {
      calls.push({ name, args });
      return typeof results[name] === 'function' ? results[name](args) : (results[name] ?? `ok ${calls.length}`);
    }
  };
}

const TOOLS = ['snapshot', 'search'].map((name) => ({
  type: 'function', function: { name, description: '', parameters: { type: 'object', properties: {} } }
}));

async function drive(replies, { hub = fakeHub(), cfg = {} } = {}) {
  const provider = await scripted(replies);
  const store = new Store(':memory:');
  const chat = store.chats.create({ title: 't' });
  store.messages.add(chat.id, { role: 'user', content: 'go' });
  try {
    await runChat({
      cfg: { baseUrl: provider.baseUrl, apiKey: 'k', model: 'm', systemPrompt: 'sys', maxToolRounds: 4, ...cfg },
      chatId: chat.id, store, tools: TOOLS, hub,
      emit: () => {}, signal: new AbortController().signal
    });
  } finally {
    provider.close();
  }
  return { hub, seen: provider.seen, rows: store.messages.list(chat.id) };
}

test('an identical call to a tool that has not declared itself idempotent runs again', async () => {
  const { hub } = await drive([
    { calls: [['snapshot', '{}']] },
    { calls: [['snapshot', '{}']] },
    { text: 'done' }
  ]);
  assert.equal(hub.calls.length, 2, 'the page may have changed between the two snapshots');
});

test('an idempotent repeat is skipped, but nested arguments that differ are not a repeat', async () => {
  const { hub, rows } = await drive([
    { calls: [['search', '{"q":{"text":"a"}}']] },
    { calls: [['search', '{"q":{"text":"b"}}']] },
    { calls: [['search', '{"q":{"text":"a"}}']] },
    { text: 'done' }
  ], { hub: fakeHub({ idempotent: ['search'] }) });

  assert.deepEqual(hub.calls.map((c) => c.args.q.text), ['a', 'b'], 'b is a new query; the second a is not');
  const skipped = rows.filter((r) => r.role === 'tool' && /^Skipped/.test(r.content));
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].content, /round 1/);
});

test('malformed arguments are refused, not run on defaults', async () => {
  const { hub, rows } = await drive([
    { calls: [['search', '{"q": "unterminated']] },
    { text: 'done' }
  ]);
  assert.equal(hub.calls.length, 0);
  const result = rows.find((r) => r.role === 'tool');
  assert.match(result.content, /were not valid JSON/);
  assert.match(result.content, /tool was not called/);
});

test('the budget rides in the system prompt and on each round\'s last result, never as a mid-conversation system message', async () => {
  const { seen, rows } = await drive([
    { calls: [['snapshot', '{}'], ['search', '{"q":"x"}']] },
    { calls: [['search', '{"q":"y"}']] },
    { text: 'done' }
  ], { cfg: { timezone: 'UTC' } });

  for (const body of seen) {
    assert.equal(body.messages.filter((m) => m.role === 'system').length, 1);
    assert.equal(body.messages[0].role, 'system');
    assert.match(body.messages[0].content, /^sys\n\n# Harness\nToday is /);
    assert.match(body.messages[0].content, /up to 4 rounds/);
  }
  assert.equal(seen[0].messages[0].content, seen[2].messages[0].content, 'same system bytes every round');

  const tools = rows.filter((r) => r.role === 'tool');
  assert.doesNotMatch(tools[0].content, /Tool budget/, 'only the last result of a round carries it');
  assert.match(tools[1].content, /\[Tool budget: 3 rounds of 4 left\.\]$/);
  assert.match(tools[2].content, /\[Tool budget: 2 rounds of 4 left -- stop broadening/);

  // What round two sent is exactly what the store rebuilds: the footer is
  // part of the history, not a note that comes and goes.
  const sentTool = seen[1].messages.find((m) => m.role === 'tool' && m.tool_call_id === tools[1].tool_call_id);
  assert.equal(sentTool.content, tools[1].content);
});

test('the last budgeted round says the budget is spent, and the final pass has tools refused', async () => {
  const { seen, rows } = await drive([
    { calls: [['search', '{"q":"1"}']] },
    { calls: [['search', '{"q":"2"}']] },
    { text: 'answer' }
  ], { cfg: { maxToolRounds: 2 } });

  assert.match(rows.filter((r) => r.role === 'tool').at(-1).content, /Tool budget spent \(2 rounds used\)/);
  assert.equal(seen.at(-1).tool_choice, 'none');
});

test('a result past maxTurnChars is stubbed even for the turn that fetched it', async () => {
  const huge = 'x'.repeat(50) + '\n' + 'y'.repeat(5000);
  const { seen } = await drive([
    { calls: [['search', '{"q":"big"}']] },
    { text: 'done' }
  ], { hub: fakeHub({ results: { search: huge } }), cfg: { maxInlineChars: 1000, maxTurnChars: 2000 } });

  const sent = seen[1].messages.find((m) => m.role === 'tool').content;
  assert.match(sent, /^\[compacted: artifact /);
  assert.match(sent, /\[Tool budget: 3 rounds of 4 left\.\]$/, 'the stub still tells the model its budget');
});

test('a result between the two caps is read whole now and stubbed only for later turns', async () => {
  const big = 'z'.repeat(1500);
  const { seen, rows } = await drive([
    { calls: [['search', '{"q":"mid"}']] },
    { text: 'done' }
  ], { hub: fakeHub({ results: { search: big } }), cfg: { maxInlineChars: 1000, maxTurnChars: 2000 } });

  assert.ok(seen[1].messages.find((m) => m.role === 'tool').content.startsWith(big));
  assert.match(rows.find((r) => r.role === 'tool').stub_text, /^\[compacted: artifact /);
});

test('a big tool block does not count as history, so it cannot force an epoch by itself', async () => {
  const bloat = [{
    type: 'function',
    function: { name: 'search', description: 'd'.repeat(80000), parameters: { type: 'object', properties: {} } }
  }];
  const setup = (store) => {
    const chat = store.chats.create({ title: 't' });
    for (let i = 0; i < 3; i++) {
      store.messages.add(chat.id, { role: 'user', content: `q${i}` });
      store.messages.add(chat.id, { role: 'assistant', content: null, tool_calls: [{ id: `t${i}`, type: 'function', function: { name: 'search', arguments: '{}' } }] });
      const artifactId = store.messages.addArtifact(chat.id, { toolName: 'search', args: {}, content: 'r'.repeat(4000) });
      store.messages.add(chat.id, { role: 'tool', tool_call_id: `t${i}`, content: 'r'.repeat(4000), artifact_id: artifactId });
      // Last request: ~20k tokens of tool definitions plus ~3k of history.
      store.messages.add(chat.id, { role: 'assistant', content: `a${i}`, usage: { prompt_tokens: 23500 } });
    }
    store.messages.add(chat.id, { role: 'user', content: 'next' });
    return chat;
  };

  const provider = await scripted([{ text: 'ok' }]);
  const run = async (threshold) => {
    const store = new Store(':memory:');
    const chat = setup(store);
    const events = [];
    await runChat({
      cfg: { baseUrl: provider.baseUrl, apiKey: 'k', model: 'm', systemPrompt: 'sys', compactThreshold: threshold, keepTurns: 1 },
      chatId: chat.id, store, tools: bloat, hub: fakeHub(),
      emit: (e) => events.push(e), signal: new AbortController().signal
    });
    return events.some((e) => e.type === 'compacted');
  };
  try {
    assert.equal(await run(20000), false, '23.5k reported, but ~20k of it is the tool block');
    assert.equal(await run(2000), true, 'history past the threshold still compacts');
  } finally {
    provider.close();
  }
});

/* ---------- automations ---------- */

test('a scheduled run cannot create or trigger automations, but can still adjust one', async () => {
  const store = new Store(':memory:');
  const chat = store.chats.create({ title: 't' });
  const ctx = { store, chatId: chat.id, unattended: true, triggerAutomation: async () => ({ ok: true }) };

  assert.match(
    await manageAutomation({ action: 'create', name: 'n', prompt: 'p', cron: '0 9 * * *', timezone: 'UTC' }, ctx),
    /not available inside a scheduled run/
  );
  assert.match(await manageAutomation({ action: 'trigger', id: 'x' }, ctx), /not available inside a scheduled run/);

  const made = JSON.parse(await manageAutomation(
    { action: 'create', name: 'n', prompt: 'p', cron: '0 9 * * *', timezone: 'UTC' },
    { ...ctx, unattended: false }
  ));
  const updated = JSON.parse(await manageAutomation({ action: 'update', id: made.id, enabled: false }, ctx));
  assert.equal(updated.enabled, false);
});

test('the run message says nobody is there to answer', () => {
  const text = runMessage({ name: 'digest', cron: '0 9 * * *', timezone: 'UTC', prompt: 'summarise the news' });
  assert.match(text, /unattended run: no one is present/);
  assert.match(text, /summarise the news$/);
});

/* ---------- old images and the hard window ---------- */

import { planEpoch, applyEpoch, planWindow, windowRows } from '../src/chat/compact.js';
import { toWire, toView } from '../src/store/index.js';

const IMG = { mime: 'image/png', data: 'iVBORw0KGgo=' };

test('an epoch takes old images off the wire and leaves them in the transcript', () => {
  const store = new Store(':memory:');
  const chat = store.chats.create({ title: 't' });
  store.messages.add(chat.id, { role: 'user', content: 'look', images: [IMG, IMG] });
  store.messages.add(chat.id, { role: 'assistant', content: 'a cat' });
  store.messages.add(chat.id, { role: 'user', content: 'and this', images: [IMG] });
  store.messages.add(chat.id, { role: 'assistant', content: 'a dog' });
  store.messages.add(chat.id, { role: 'user', content: 'thanks' });

  const plan = planEpoch(store.messages.list(chat.id), { threshold: 1, keepTurns: 2, promptTokens: 99 });
  assert.equal(plan.targets.length, 1, 'only the image outside the last two turns');
  assert.ok(applyEpoch(store, chat, plan));

  const [old, , recent] = store.messages.list(chat.id);
  const wire = toWire(old);
  assert.equal(typeof wire.content, 'string', 'no image parts left');
  assert.match(wire.content, /^look\n\n\[2 images attached here were removed from context/);
  assert.ok(Array.isArray(toWire(recent).content), 'recent turn keeps its image');
  assert.equal(toView(old).images.length, 2, 'the transcript still has them');
  assert.equal(planEpoch(store.messages.list(chat.id), { threshold: 1, keepTurns: 2, promptTokens: 99 }), null,
    'dropped once, never again');
});

function chatter(store, turns, size = 4000) {
  const chat = store.chats.create({ title: 't' });
  for (let i = 0; i < turns; i++) {
    store.messages.add(chat.id, { role: 'user', content: `q${i} ` + 'u'.repeat(size) });
    store.messages.add(chat.id, { role: 'assistant', content: `a${i} ` + 'a'.repeat(size) });
  }
  return chat;
}

test('the window cuts on a user message, down to the target, and never into the kept turns', () => {
  const store = new Store(':memory:');
  const chat = chatter(store, 10); // ~20k tokens, 2k per turn
  const rows = store.messages.list(chat.id);

  assert.equal(planWindow(rows, { maxTokens: 50000, targetTokens: 25000, keepTurns: 2, toWire }), null);

  const cut = planWindow(rows, { maxTokens: 15000, targetTokens: 7000, keepTurns: 2, toWire });
  const kept = rows.filter((r) => r.seq >= cut);
  assert.equal(kept[0].role, 'user');
  assert.ok(kept.length / 2 <= 3.5 && kept.length / 2 >= 3, `about 7k of 2k turns, got ${kept.length / 2}`);

  const tight = planWindow(rows, { maxTokens: 100, targetTokens: 50, keepTurns: 2, toWire });
  assert.equal(rows.filter((r) => r.seq >= tight).length, 4, 'the last two turns stay whatever they cost');

  const shown = windowRows(rows, cut);
  assert.match(shown[0].content, /^\[Earlier conversation omitted: \d+ messages before this point/);
  assert.deepEqual(windowRows(rows, cut), shown, 'deterministic');
});

test('a long plain-text chat is windowed once and then stays put', async () => {
  const provider = await scripted([{ text: 'ok' }]);
  const store = new Store(':memory:');
  const chat = chatter(store, 10);
  const cfg = { baseUrl: provider.baseUrl, apiKey: 'k', model: 'm', systemPrompt: 'sys', maxHistoryTokens: 15000 };
  const turn = async (q) => {
    store.messages.add(chat.id, { role: 'user', content: q });
    const events = [];
    await runChat({ cfg, chatId: chat.id, store, tools: [], hub: fakeHub(), emit: (e) => events.push(e),
      signal: new AbortController().signal });
    return events;
  };
  try {
    const first = await turn('next');
    assert.ok(first.some((e) => e.type === 'notice' && /Context window full/.test(e.text)));
    const sent = provider.seen[0].messages;
    assert.equal(sent[1].role, 'user');
    assert.match(sent[1].content, /^\[Earlier conversation omitted/);
    const windowAt = store.chats.byId(chat.id).window_seq;
    assert.ok(windowAt > 0);

    await turn('again');
    assert.equal(store.chats.byId(chat.id).window_seq, windowAt, 'no move while under the limit');
    const [a, b] = provider.seen.map((body) => body.messages);
    assert.deepEqual(b.slice(0, a.length), a, 'the second turn extends the first byte for byte');
  } finally {
    provider.close();
  }
});

/* ---------- empty answers and tool names ---------- */

import { uniqueName } from '../src/mcp.js';

test('a final pass that comes back empty says so instead of storing a blank answer', async () => {
  const { rows } = await drive([
    { calls: [['search', '{"q":"1"}']] },
    { calls: [['search', '{"q":"2"}']] } // ignores tool_choice: none on the final pass
  ], { cfg: { maxToolRounds: 1 } });
  const last = rows.at(-1);
  assert.equal(last.role, 'assistant');
  assert.equal(last.tool_calls_json, null);
  assert.match(last.content, /^\(No answer: the tool budget ran out/);
});

test('an empty reply mid-budget is marked too', async () => {
  const { rows } = await drive([{ text: '' }]);
  assert.equal(rows.at(-1).content, '(The model returned an empty reply.)');
});

test('flattened tool names never collide', () => {
  const taken = new Map();
  const add = (raw) => { const n = uniqueName(raw, taken); taken.set(n, raw); return n; };

  assert.equal(add('srv__a.b'), 'srv__a_b');
  assert.equal(add('srv__a_b'), 'srv__a_b_2', 'sanitising made these two the same');

  const long = 'x'.repeat(70);
  const one = add(`srv__${long}1`);
  const two = add(`srv__${long}2`);
  assert.equal(one.length, 64);
  assert.equal(two.length, 64);
  assert.notEqual(one, two, 'truncation made these two the same');

  assert.equal(add('context_expand'), 'context_expand_2', 'a built-in name is never shadowed');
});

/* ---------- approval ---------- */

function gatedHub({ readOnly = [], local = [] } = {}) {
  return { ...fakeHub(), isReadOnly: (n) => readOnly.includes(n), isLocal: (n) => local.includes(n) };
}

async function gated(replies, { hub, cfg = {}, answers = [], unattended = false }) {
  const provider = await scripted(replies);
  const store = new Store(':memory:');
  const chat = store.chats.create({ title: 't' });
  store.messages.add(chat.id, { role: 'user', content: 'go' });
  const asked = [];
  const events = [];
  try {
    await runChat({
      cfg: { baseUrl: provider.baseUrl, apiKey: 'k', model: 'm', systemPrompt: 'sys', toolApproval: 'writes', ...cfg },
      chatId: chat.id, store, tools: TOOLS, hub, unattended,
      emit: (e) => events.push(e), signal: new AbortController().signal,
      approve: async (call) => { asked.push(call.name); return answers.shift() ?? 'deny'; }
    });
  } finally {
    provider.close();
  }
  return { asked, events, rows: store.messages.list(chat.id), calls: hub.calls };
}

test('a write waits for the user, and a denied call is never run', async () => {
  const { asked, calls, rows, events } = await gated(
    [{ calls: [['snapshot', '{}']] }, { text: 'ok' }],
    { hub: gatedHub(), answers: ['deny'] }
  );
  assert.deepEqual(asked, ['snapshot']);
  assert.equal(calls.length, 0);
  assert.match(rows.find((r) => r.role === 'tool').content, /^The user declined this call/);
  assert.deepEqual(events.filter((e) => e.type.startsWith('approval')).map((e) => e.type), ['approval', 'approval_done']);
});

test('"always allow" runs the call and stops asking for that tool within the turn', async () => {
  const { asked, calls } = await gated(
    [{ calls: [['snapshot', '{}']] }, { calls: [['snapshot', '{"x":1}']] }, { text: 'ok' }],
    { hub: gatedHub(), answers: ['always'] }
  );
  assert.deepEqual(asked, ['snapshot'], 'asked once');
  assert.equal(calls.length, 2);
});

test('read-only tools, overrides and the built-ins decide who asks', async () => {
  const readOnly = await gated([{ calls: [['search', '{}']] }, { text: 'ok' }], { hub: gatedHub({ readOnly: ['search'] }) });
  assert.deepEqual(readOnly.asked, [], 'a declared read never asks under "writes"');

  const forced = await gated([{ calls: [['search', '{}']] }, { text: 'ok' }],
    { hub: gatedHub({ readOnly: ['search'] }), cfg: { confirmTools: ['search'] }, answers: ['allow'] });
  assert.deepEqual(forced.asked, ['search'], 'confirmTools wins over read-only');

  const trusted = await gated([{ calls: [['snapshot', '{}']] }, { text: 'ok' }],
    { hub: gatedHub(), cfg: { autoApproveTools: ['snapshot'] } });
  assert.deepEqual(trusted.asked, []);

  const builtin = await gated([{ calls: [['snapshot', '{}']] }, { text: 'ok' }],
    { hub: gatedHub({ local: ['snapshot'] }), cfg: { toolApproval: 'all', confirmTools: ['snapshot'] } });
  assert.deepEqual(builtin.asked, [], 'the harness\'s own tools never ask');
  assert.equal(builtin.calls.length, 1);
});

test('a scheduled run refuses a call that would ask, without asking anyone', async () => {
  const { asked, calls, rows } = await gated(
    [{ calls: [['snapshot', '{}']] }, { text: 'ok' }],
    { hub: gatedHub(), unattended: true }
  );
  assert.deepEqual(asked, []);
  assert.equal(calls.length, 0);
  assert.match(rows.find((r) => r.role === 'tool').content, /unattended scheduled run/);
});
