// Lifecycle hooks at the tool and turn boundaries, driven through runChat
// against a scripted provider so approvals and persistence are the real ones.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { Store } from '../src/store/index.js';
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

const TOOLS = ['search', 'write'].map((name) => ({
  type: 'function', function: { name, description: '', parameters: { type: 'object', properties: {} } }
}));

async function drive(replies, { hooks, approve = null, cfg = {}, signal } = {}) {
  const provider = await scripted(replies);
  const store = new Store(':memory:');
  const chat = store.createChat({ title: 't' });
  store.addMessage(chat.id, { role: 'user', content: 'go' });
  const calls = [];
  const events = [];
  const hub = {
    instructionsBlock: () => '',
    call: async (name, args) => { calls.push(name); return `raw ${name}`; }
  };
  let error = null;
  try {
    await runChat({
      cfg: { baseUrl: provider.baseUrl, apiKey: 'k', model: 'm', systemPrompt: 'sys', maxToolRounds: 4, ...cfg },
      chatId: chat.id, store, tools: TOOLS, hub, hooks, approve,
      emit: (e) => events.push(e), signal: signal || new AbortController().signal
    });
  } catch (err) {
    error = err;
  } finally {
    provider.close();
  }
  return { calls, events, error, seen: provider.seen, rows: store.messages(chat.id) };
}

const toolRows = (rows) => rows.filter((r) => r.role === 'tool').map((r) => r.content);

test('hooks run in documented order: approval, then beforeToolCall hooks, then afterToolCall hooks', async () => {
  const order = [];
  await drive([{ calls: [['write', '{}']] }, { text: 'done' }], {
    cfg: { toolApproval: 'always' },
    approve: async () => { order.push('approval'); return 'allow'; },
    hooks: {
      beforeToolCall: [() => { order.push('before1'); }, () => { order.push('before2'); }],
      afterToolCall: [() => { order.push('after1'); }, () => { order.push('after2'); }],
      afterTurn: [() => { order.push('turn'); }]
    }
  });
  assert.deepEqual(order, ['approval', 'before1', 'before2', 'after1', 'after2', 'turn']);
});

test('a beforeToolCall block refuses the call and stops later hooks', async () => {
  let later = false;
  const { calls, rows } = await drive([{ calls: [['search', '{"q":1}']] }, { text: 'done' }], {
    hooks: { beforeToolCall: [({ args }) => (args.q === 1 ? { block: 'Refused by policy.' } : undefined), () => { later = true; }] }
  });
  assert.deepEqual(calls, []);
  assert.equal(later, false);
  assert.match(toolRows(rows)[0], /^Refused by policy\./);
});

test('no call runs before a denied approval, and hooks after it never see the call', async () => {
  let reached = false;
  const { calls, rows } = await drive([{ calls: [['write', '{}']] }, { text: 'done' }], {
    cfg: { toolApproval: 'always' },
    approve: async () => 'deny',
    hooks: { beforeToolCall: [() => { reached = true; }] }
  });
  assert.deepEqual(calls, []);
  assert.equal(reached, false);
  assert.match(toolRows(rows)[0], /declined/);
});

test('afterToolCall hooks chain result rewrites without touching the loop', async () => {
  const { rows, seen } = await drive([{ calls: [['search', '{}']] }, { text: 'done' }], {
    hooks: { afterToolCall: [({ result }) => ({ result: `${result} +a` }), ({ result }) => ({ result: `${result} +b` })] }
  });
  assert.match(toolRows(rows)[0], /^raw search \+a \+b/);
  assert.match(seen[1].messages.at(-1).content, /^raw search \+a \+b/, 'the model sees the rewrite too');
});

test('a stop from afterToolCall or afterTurn ends the run before the next model call', async () => {
  for (const hooks of [
    { afterToolCall: [() => ({ stop: true })] },
    { afterTurn: [() => ({ stop: true })] }
  ]) {
    const { seen, rows } = await drive([{ calls: [['search', '{}'], ['search', '{"x":1}']] }, { text: 'done' }], { hooks });
    assert.equal(seen.length, 1);
    assert.equal(toolRows(rows).length, 2, 'the batch completes, so every call has its result');
  }
});

test('hook failures are visible and deterministic', async () => {
  const before = await drive([{ calls: [['search', '{}']] }, { text: 'done' }], {
    hooks: { beforeToolCall: [() => { throw new Error('boom'); }] }
  });
  assert.deepEqual(before.calls, [], 'a failing policy check does not let the call through');
  assert.match(toolRows(before.rows)[0], /policy check for "search" failed \(boom\)/);
  assert.ok(before.events.some((e) => e.type === 'notice' && /boom/.test(e.text)));

  const after = await drive([{ calls: [['search', '{}']] }, { text: 'done' }], {
    hooks: { afterToolCall: [() => { throw new Error('bang'); }] }
  });
  assert.match(toolRows(after.rows)[0], /^raw search/, 'the result is kept as returned');
  assert.ok(after.events.some((e) => e.type === 'notice' && /bang/.test(e.text)));

  const turn = await drive([{ calls: [['search', '{}']] }, { text: 'done' }], {
    hooks: { afterTurn: [() => { throw new Error('crash'); }] }
  });
  assert.equal(turn.seen.length, 1, 'a failing turn hook stops the run');
  assert.ok(turn.events.some((e) => e.type === 'notice' && /crash/.test(e.text)));
});

test('an abort during an async hook ends the run', async () => {
  const ac = new AbortController();
  const { error, calls } = await drive([{ calls: [['search', '{}']] }, { text: 'done' }], {
    signal: ac.signal,
    hooks: { beforeToolCall: [({ signal }) => new Promise((r) => { signal.addEventListener('abort', r); ac.abort(); })] }
  });
  assert.match(String(error?.message), /Stopped/);
  assert.deepEqual(calls, []);
});
