import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, toWire } from '../src/store/index.js';
import { repairToolHistory } from '../src/chat/history.js';
import { toolExecutor } from '../src/chat/tool_executor.js';
import { createServer } from 'node:http';
import { runChat, buildMessages } from '../src/chat/llm.js';
import { prepareContext, requestSize, requestBudget, validCheckpoint } from '../src/chat/checkpoint.js';
import { configProblems } from '../src/config/config.js';
import { effectiveConfig } from '../src/config/models.js';

const call = (id = 'c') => ({ id, type: 'function', function: { name: 'write', arguments: '{}' } });
const summary = [
  '## Objective\nComplete the research.',
  '## User constraints\nOnly standard ownership; maximum EUR 600000.',
  '## Decisions\nExclude leases.',
  '## Verified findings\nNone.',
  '## Assumptions and uncertainty\nAvailability still needs checking.',
  '## Unfinished work and evidence\nVerify listings and cite evidence.'
].join('\n');

test('Stop during approval closes every stored call without executing anything', async (t) => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const chat = store.chats.create();
  const calls = [call('a'), call('b')];
  store.messages.add(chat.id, { role: 'assistant', tool_calls: calls });
  const ac = new AbortController();
  let executions = 0;
  const executor = toolExecutor({
    cfg: { toolApproval: 'all' }, chatId: chat.id, store,
    hub: { isLocal: () => false, call: async () => { executions++; return 'ok'; } },
    emit: () => {}, approve: async () => { ac.abort(); return 'deny'; },
    footer: () => '', hooks: {}, signal: ac.signal
  });
  const results = await executor.execute(calls, { round: 0 });
  assert.equal(executions, 0);
  assert.deepEqual(results.map((r) => r.wire.tool_call_id), ['a', 'b']);
  assert.ok(results.every((r) => /stopped/.test(r.wire.content)));
  assert.equal(repairToolHistory(store.messages.list(chat.id).map(toWire)).length, 3);
});

test('interrupted history gets unknown-outcome results before the next user message', () => {
  const messages = [{ role: 'assistant', tool_calls: [call('a'), call('b')] },
    { role: 'tool', tool_call_id: 'a', content: 'done' }, { role: 'user', content: 'continue' }];
  const repaired = repairToolHistory(messages);
  assert.equal(repaired[2].tool_call_id, 'b');
  assert.match(repaired[2].content, /unknown/);
  assert.equal(repaired[3].role, 'user');
  assert.deepEqual(repairToolHistory(repaired), repaired);
  assert.throws(() => repairToolHistory([{ role: 'tool', tool_call_id: 'orphan' }]), /orphan/);
});

test('reasoning replay survives storage and uses the provider-specific field', async (t) => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const chat = store.chats.create();
  const message = { role: 'assistant', content: null, reasoning: 'retained plan',
    reasoning_details: [{ type: 'reasoning.text', text: 'structured plan' }], tool_calls: [call()] };
  store.messages.add(chat.id, message);
  const history = store.messages.list(chat.id).map(toWire);
  const cfg = { baseUrl: 'https://api.deepseek.com/v1', systemPrompt: 's', model: 'deepseek-reasoner' };
  const direct = buildMessages(cfg, history)[1];
  assert.equal(direct.reasoning_content, 'retained plan');
  assert.equal(direct.reasoning_details, undefined);
  assert.deepEqual(buildMessages(cfg, [message]), buildMessages(cfg, history));
  const router = buildMessages({ ...cfg, baseUrl: 'https://openrouter.ai/api/v1' }, history)[1];
  assert.equal(router.reasoning_content, undefined);
  assert.deepEqual(router.reasoning_details, message.reasoning_details);
  const custom = buildMessages({ ...cfg, baseUrl: 'http://localhost:9000/v1', reasoningReplay: 'reasoning_content' }, history)[1];
  assert.equal(custom.reasoning_content, 'retained plan');
  assert.equal(buildMessages({ ...cfg, reasoningReplay: 'omit' }, history)[1].reasoning_content, undefined);
});

test('budget counts schemas, replayed reasoning and output reserve', () => {
  assert.equal(requestBudget({ contextWindowTokens: 10000, maxTokens: 2000 }), 8000);
  assert.throws(() => requestBudget({ contextWindowTokens: 1000, maxTokens: 2000 }), /no input space/);
  assert.ok(requestSize([{ role: 'assistant', reasoning_content: 'x'.repeat(1000) }]) > 250);
  assert.ok(requestSize([], [{ description: 'x'.repeat(1000) }]) > 250);
});

function fixture(t) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const chat = store.chats.create();
  for (let i = 0; i < 5; i++) {
    store.messages.add(chat.id, { role: 'user', content: 'Only standard ownership. ' + 'x'.repeat(1200) });
    store.messages.add(chat.id, { role: 'assistant', content: 'Noted. ' + 'y'.repeat(1200) });
  }
  store.messages.add(chat.id, { role: 'user', content: 'Continue the search.' });
  const cfg = { model: 'test', systemPrompt: 's', contextWindowTokens: 5000,
    contextReserveTokens: 2000, compactionMaxTokens: 256, llmCompaction: true, keepTurns: 1 };
  return { store, chat, cfg, params: { cfg, store, chatId: chat.id, tools: [],
    startSeq: store.messages.nextSeq(chat.id), serialize: (h) => buildMessages(cfg, h), notice: () => {} } };
}

test('checkpoint persists, replays identically, retains archive and is undone by rewind', async (t) => {
  const { store, chat, params } = fixture(t);
  let calls = 0;
  const summarize = async (source) => { calls++; assert.match(source, /standard ownership/); return { text: summary }; };
  const before = store.messages.list(chat.id).length;
  const first = await prepareContext({ ...params, summarize });
  assert.equal(calls, 1);
  assert.equal(store.messages.list(chat.id).length, before);
  const checkpoint = JSON.parse(store.chats.byId(chat.id).checkpoint_json);
  assert.ok(store.messages.getArtifact(checkpoint.archiveId, chat.id));
  assert.equal(store.messages.getArtifact(checkpoint.archiveId, 'another-chat'), null);
  assert.match(first[0].content, /EUR 600000/);
  const again = await prepareContext({ ...params, summarize });
  assert.deepEqual(again, first);
  assert.equal(calls, 1);
  store.chats.truncateFrom(chat.id, 0);
  assert.equal(store.chats.byId(chat.id).checkpoint_json, null);
  assert.equal(store.chats.byId(chat.id).window_seq, -1);
});

test('invalid, failed and aborted summaries never advance the window', async (t) => {
  const { store, chat, params } = fixture(t);
  for (const summarize of [
    async () => ({ text: '' }),
    async () => { throw new Error('provider failed'); }
  ]) {
    await assert.rejects(prepareContext({ ...params, summarize }));
    assert.equal(store.chats.byId(chat.id).window_seq, -1);
    assert.equal(store.chats.byId(chat.id).checkpoint_json, null);
  }
  const ac = new AbortController();
  await assert.rejects(prepareContext({ ...params, signal: ac.signal,
    summarize: async () => { ac.abort(); return { text: summary }; } }), /Stopped/);
  assert.equal(store.chats.byId(chat.id).checkpoint_json, null);
  assert.equal(validCheckpoint('looks fine'), false);
});

test('automation boundary does not inherit an interactive checkpoint', async (t) => {
  const { store, chat, params } = fixture(t);
  await prepareContext({ ...params, summarize: async () => ({ text: summary }) });
  const seq = store.messages.add(chat.id, { role: 'user', content: 'Automation prompt' });
  const messages = await prepareContext({ ...params, historyFromSeq: seq,
    summarize: async () => { throw new Error('should not summarize'); } });
  assert.deepEqual(messages, [{ role: 'user', content: 'Automation prompt' }]);
});

test('cumulative tool results are stubbed before the next request and stay stubbed', async (t) => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const chat = store.chats.create();
  store.messages.add(chat.id, { role: 'user', content: 'research' });
  for (let i = 0; i < 3; i++) {
    store.messages.add(chat.id, { role: 'assistant', tool_calls: [call(String(i))] });
    const content = 'x'.repeat(5000);
    const id = store.messages.addArtifact(chat.id, { toolName: 'search', content });
    store.messages.add(chat.id, { role: 'tool', tool_call_id: String(i), content, artifact_id: id });
  }
  const cfg = { contextWindowTokens: 4000, contextReserveTokens: 1000, maxTurnChars: 120000 };
  const params = { cfg, store, chatId: chat.id, tools: [], startSeq: 1,
    forcedStubs: new Set(), serialize: (h) => h, notice: () => {} };
  const first = await prepareContext(params);
  assert.ok(requestSize(first) <= requestBudget(cfg));
  assert.deepEqual(await prepareContext(params), first);
  assert.equal(store.messages.list(chat.id).filter((r) => r.role === 'tool').every((r) => r.content.length === 5000), true);
});

test('compaction usage is counted without creating a completed chat answer and is scoped', async (t) => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const chat = store.chats.create({}, null);
  store.usage.addAuxRequest(chat.id, 'model', { prompt_tokens: 100, completion_tokens: 20, cost: 0.01 });
  const stats = store.usage.statistics(null);
  assert.equal(stats.completedAnswers, 0);
  assert.equal(stats.reportedCost, 0.01);
  assert.equal(stats.models[0].in, 100);
  assert.equal(store.usage.rollup(null)[0].in, 100);
  assert.equal(store.usage.statistics('different-user').reportedCost, null);
});

test('new settings validate and can be overridden by the model catalog', () => {
  assert.ok(configProblems({ reasoningReplay: 'whatever' }).length);
  assert.ok(configProblems({ contextWindowTokens: -1 }).length);
  const cfg = { model: 'm', models: [{ id: 'm', contextWindowTokens: 32000, reasoningReplay: 'reasoning_content' }] };
  assert.equal(configProblems(cfg).length, 0);
  assert.equal(effectiveConfig(cfg).contextWindowTokens, 32000);
});

test('runChat makes a tool-free summary request, bills it and resumes the original question', async (t) => {
  const { store, chat, cfg } = fixture(t);
  const requests = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw); requests.push(body);
      const content = requests.length === 1 ? summary : 'Here are the results.';
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 30, cost: 0.01 } }) + '\n\n');
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  await runChat({ cfg: { ...cfg, baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1' },
    store, chatId: chat.id, tools: [], hub: { instructionsBlock: () => '' }, emit: () => {},
    signal: new AbortController().signal });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].tools, undefined);
  assert.match(requests[1].messages[1].content, /Conversation checkpoint/);
  assert.equal(store.messages.list(chat.id).at(-1).content, 'Here are the results.');
  assert.equal(store.usage.statistics(null).reportedCost, 0.02);
});
