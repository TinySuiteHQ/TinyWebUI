// Tool batches: parallel-safe calls overlap, but results, approvals and the
// transcript behave exactly as if they had run one by one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { Store } from '../src/store.js';
import { runChat } from '../src/chat/llm.js';

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
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  const port = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
  return { seen, baseUrl: `http://127.0.0.1:${port}/v1`, close: () => srv.close() };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const TOOLS = ['slow', 'fast', 'write'].map((name) => ({
  type: 'function', function: { name, description: '', parameters: { type: 'object', properties: {} } }
}));

/** slow and fast are parallel-safe reads; write is sequential and needs approval. */
function fakeHub({ delays = { slow: 150, fast: 10, write: 10 } } = {}) {
  const log = [];
  return {
    log,
    instructionsBlock: () => '',
    isIdempotent: (n) => n !== 'write',
    isReadOnly: (n) => n !== 'write',
    executionMode: (n) => (n === 'write' ? 'sequential' : 'parallel'),
    call: async (name, args) => {
      log.push(`start ${name}`);
      await wait(delays[name]);
      log.push(`end ${name}`);
      return args.fail ? `Error: ${name} failed` : `${name} ${JSON.stringify(args)}`;
    }
  };
}

async function drive(replies, { hub = fakeHub(), approve = null, signal, cfg = {} } = {}) {
  const provider = await scripted(replies);
  const store = new Store(':memory:');
  const chat = store.createChat({ title: 't' });
  store.addMessage(chat.id, { role: 'user', content: 'go' });
  const events = [];
  let error = null;
  const t0 = Date.now();
  try {
    await runChat({
      cfg: { baseUrl: provider.baseUrl, apiKey: 'k', model: 'm', systemPrompt: 'sys', maxToolRounds: 4, ...cfg },
      chatId: chat.id, store, tools: TOOLS, hub, approve,
      emit: (e) => events.push(e), signal: signal || new AbortController().signal
    });
  } catch (err) { error = err; } finally { provider.close(); }
  return { hub, events, error, ms: Date.now() - t0, seen: provider.seen, rows: store.messages(chat.id) };
}

const toolRows = (rows) => rows.filter((r) => r.role === 'tool');

test('independent reads overlap, and results keep the order of the calls, not of completion', async () => {
  const { ms, hub, rows, seen, events } = await drive([
    { calls: [['slow', '{"a":1}'], ['slow', '{"a":2}'], ['fast', '{}']] }, { text: 'done' }
  ]);
  assert.ok(ms < 290, `took ${ms}ms: two 150ms calls should overlap`);
  assert.deepEqual(hub.log.slice(0, 3), ['start slow', 'start slow', 'start fast']);
  assert.deepEqual(toolRows(rows).map((r) => r.tool_call_id), ['c1_0', 'c1_1', 'c1_2']);
  assert.deepEqual(seen[1].messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id), ['c1_0', 'c1_1', 'c1_2']);
  assert.deepEqual(events.filter((e) => e.type === 'tool_result').map((e) => e.id), ['c1_2', 'c1_0', 'c1_1'],
    'the UI hears results as they land');
});

test('one sequential call makes the whole batch run one at a time', async () => {
  const { hub } = await drive([{ calls: [['slow', '{}'], ['write', '{}'], ['fast', '{}']] }, { text: 'done' }]);
  assert.deepEqual(hub.log, ['start slow', 'end slow', 'start write', 'end write', 'start fast', 'end fast']);
});

test('every approval is settled before any call in the batch runs, and a denied call never runs', async () => {
  const hub = fakeHub();
  const asked = [];
  const { rows } = await drive([{ calls: [['write', '{"n":1}'], ['write', '{"n":2}'], ['fast', '{}']] }, { text: 'done' }], {
    hub,
    cfg: { toolApproval: 'always' },
    approve: async ({ id }) => {
      asked.push({ id, started: hub.log.length });
      return id === 'c1_0' ? 'allow' : 'deny';
    }
  });
  assert.deepEqual(asked.map((a) => a.started), asked.map(() => 0), 'nothing started while asking');
  assert.equal(hub.log.filter((l) => l === 'start write').length, 1);
  const tools = toolRows(rows);
  assert.match(tools[0].content, /^write \{"n":1\}/);
  assert.match(tools[1].content, /declined/);
});

test('an error from one call does not disturb the others', async () => {
  const { rows } = await drive([{ calls: [['slow', '{"fail":true}'], ['fast', '{}']] }, { text: 'done' }]);
  const tools = toolRows(rows);
  assert.match(tools[0].content, /^Error: slow failed/);
  assert.match(tools[1].content, /^fast \{\}/);
});

test('an identical idempotent call in the same batch is skipped, not run twice', async () => {
  const { hub, rows } = await drive([{ calls: [['slow', '{"a":1}'], ['slow', '{"a":1}']] }, { text: 'done' }]);
  assert.equal(hub.log.filter((l) => l === 'start slow').length, 1);
  assert.match(toolRows(rows)[1].content, /^Skipped: this is an identical call/);
});

test('a stop abandons in-flight calls, and every call still has a result', async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 40);
  const { error, rows, ms } = await drive([{ calls: [['slow', '{"a":1}'], ['slow', '{"a":2}']] }, { text: 'done' }], { signal: ac.signal });
  assert.ok(error, 'the run ends');
  assert.ok(ms < 140, `took ${ms}ms: nothing waited for the slow calls`);
  const tools = toolRows(rows);
  assert.equal(tools.length, 2);
  for (const t of tools) assert.match(t.content, /stopped before this call finished/);
});

test('a batch of N calls is still one round of the budget', async () => {
  const { seen } = await drive([{ calls: [['fast', '{"i":1}'], ['fast', '{"i":2}'], ['fast', '{"i":3}']] }], { cfg: { maxToolRounds: 2 } });
  // Two tool rounds plus the final tool-less pass.
  assert.equal(seen.length, 3);
  assert.equal(seen[2].tool_choice, 'none');
});
