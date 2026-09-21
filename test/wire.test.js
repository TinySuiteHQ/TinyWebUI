import test from 'node:test';
import assert from 'node:assert/strict';

import { buildBody, buildMessages, budgetNote } from '../src/llm.js';
import { Store, toWire } from '../src/store.js';

const CLAUDE = { cache: true, model: 'anthropic/claude-sonnet-5', systemPrompt: 'sys', cacheTtl: '5m' };
const OPENROUTER_CLAUDE = { ...CLAUDE, baseUrl: 'https://openrouter.ai/api/v1' };
const DEEPSEEK = { cache: true, model: 'deepseek/deepseek-v4-flash-0731', systemPrompt: 'sys' };
const OPENROUTER_QWEN = {
  cache: true,
  baseUrl: 'https://openrouter.ai/api/v1',
  model: 'qwen/qwen3-max',
  systemPrompt: 'sys'
};
const OPENROUTER_GEMINI = {
  cache: true,
  baseUrl: 'https://openrouter.ai/api/v1',
  model: 'google/gemini-2.5-pro',
  systemPrompt: 'sys'
};

const marks = (msgs) =>
  msgs.reduce((acc, m, i) => (Array.isArray(m.content) && m.content[0]?.cache_control ? [...acc, i] : acc), []);

/* ---------- canonicalisation: the thing the whole cache rests on ---------- */

test('a just-appended message and one rebuilt from the store serialise identically', () => {
  const store = new Store(':memory:');
  const chat = store.createChat({ title: 't' });

  // Shapes built in three different key orders, as the loop actually builds them.
  const assistant = { role: 'assistant', content: 'hi', usage: { prompt_tokens: 5 }, reasoning: 'think' };
  const tool = { content: 'result', role: 'tool', tool_call_id: 'tc1', artifact_id: 'a1' };
  store.addMessage(chat.id, { role: 'user', content: 'q' });
  store.addMessage(chat.id, assistant);
  store.addMessage(chat.id, tool);

  const live = [{ role: 'user', content: 'q' }, assistant, toWire(tool)];
  const stored = store.messages(chat.id).map(toWire);

  assert.equal(
    JSON.stringify(buildMessages(DEEPSEEK, live)),
    JSON.stringify(buildMessages(DEEPSEEK, stored)),
    'identical bytes, or the prefix misses on the next turn'
  );
});

test('reasoning text never reaches the wire; reasoning_details only where required', () => {
  const history = [{ role: 'assistant', content: 'a', reasoning: 'secret', reasoning_details: [{ text: 'd' }] }];
  const ds = JSON.stringify(buildMessages(DEEPSEEK, history));
  assert.ok(!ds.includes('secret'));
  assert.ok(!ds.includes('reasoning_details'), 'DeepSeek rejects it being echoed back');

  const cl = JSON.stringify(buildMessages(CLAUDE, history));
  assert.ok(!cl.includes('secret'));
  assert.ok(cl.includes('reasoning_details'), 'Anthropic rejects the follow-up without it');
});

test('usage rides on the stored message but never on the wire', () => {
  const wire = JSON.stringify(buildMessages(DEEPSEEK, [{ role: 'assistant', content: 'a', usage: { prompt_tokens: 9 } }]));
  assert.ok(!wire.includes('prompt_tokens'));
});

/* ---------- breakpoints ---------- */

const convo = [
  { role: 'user', content: 'q1' },
  { role: 'assistant', content: null, tool_calls: [{ id: 't', type: 'function', function: { name: 'f', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: 't', content: 'compacted stub' },
  { role: 'assistant', content: 'a1' },
  { role: 'user', content: 'q2' },
  { role: 'assistant', content: 'a2' }
];

test('models without explicit breakpoints get none', () => {
  assert.deepEqual(marks(buildMessages(DEEPSEEK, convo)), []);
});

test('system and the newest text turn are marked', () => {
  const out = buildMessages(CLAUDE, convo);
  assert.deepEqual(marks(out), [0, out.length - 1]);
});

test('a frozen epoch gets its own pinned breakpoint behind the rolling one', () => {
  // epochIndex 3 => history[3] ("a1"), which is messages[4].
  const out = buildMessages(CLAUDE, convo, 3);
  assert.deepEqual(marks(out), [0, 4, out.length - 1]);
});

test('the pinned breakpoint is skipped when it would collide with the rolling one', () => {
  const out = buildMessages(CLAUDE, convo, convo.length - 1);
  assert.deepEqual(marks(out), [0, out.length - 1], 'no duplicate marker on one message');
});

test('a breakpoint never lands on a tool result or a tool-call-only turn', () => {
  // history[1] is tool_calls-only and history[2] is a tool result; the marker
  // must walk back to the user turn rather than mark either.
  const out = buildMessages(CLAUDE, convo, 2);
  assert.deepEqual(marks(out), [0, 1, out.length - 1]);
  assert.equal(out[1].role, 'user');
});

test('caching off means no markers at all', () => {
  assert.deepEqual(marks(buildMessages({ ...CLAUDE, cache: false }, convo, 3)), []);
});


test('OpenRouter gets a stable per-chat session_id without clobbering an override', () => {
  const plan = { turn: convo, tools: [], lastCall: false, epochIndex: -1, chatId: 'chat-123' };
  const body = buildBody(OPENROUTER_CLAUDE, plan, new Set());
  assert.equal(body.session_id, 'chat-123');

  const overridden = buildBody(
    { ...OPENROUTER_CLAUDE, extraBody: { session_id: 'custom-session' } },
    plan,
    new Set()
  );
  assert.equal(overridden.session_id, 'custom-session');
});

test('OpenRouter Claude uses automatic cache_control so tool results can advance the cache', () => {
  const toolTail = convo.slice(0, 3); // ends in a client tool result
  const body = buildBody(
    OPENROUTER_CLAUDE,
    { turn: toolTail, tools: [], lastCall: false, epochIndex: -1, chatId: 'c' },
    new Set()
  );
  assert.deepEqual(body.cache_control, { type: 'ephemeral' });
  assert.deepEqual(marks(body.messages), [], 'automatic mode owns the rolling breakpoint');
  assert.equal(body.messages.at(-1).role, 'tool');
});

test('Claude 1h TTL reaches the automatic OpenRouter cache directive', () => {
  const cfg = { ...OPENROUTER_CLAUDE, cacheTtl: '1h' };
  const body = buildBody(
    cfg,
    { turn: convo, tools: [], lastCall: false, epochIndex: -1, chatId: 'c' },
    new Set()
  );
  assert.equal(body.cache_control.ttl, '1h');
  assert.deepEqual(marks(body.messages), []);
});

test('OpenRouter Qwen and Gemini cache the prefix themselves and get no markers', () => {
  // A marker makes the marked message's content an array; the rolling
  // breakpoint moves off it next round and it reverts to a string. On a
  // gateway that prefix-matches the serialised request that is a byte change
  // mid-prefix, which costs more than the marker could ever buy.
  assert.deepEqual(marks(buildMessages(OPENROUTER_QWEN, convo)), []);
  assert.deepEqual(marks(buildMessages(OPENROUTER_GEMINI, convo)), []);
});

test('non-OpenRouter Gemini remains implicit and receives no OpenRouter-specific markers', () => {
  const cfg = { ...OPENROUTER_GEMINI, baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' };
  assert.deepEqual(marks(buildMessages(cfg, convo)), []);
});


test('explicitly routed OpenRouter Claude falls back to portable explicit breakpoints', () => {
  const cfg = {
    ...OPENROUTER_CLAUDE,
    extraBody: { provider: { order: ['Amazon Bedrock'], allow_fallbacks: true } }
  };
  const body = buildBody(
    cfg,
    { turn: convo, tools: [], lastCall: false, epochIndex: -1, chatId: 'c' },
    new Set()
  );
  assert.equal(body.cache_control, undefined);
  assert.ok(marks(body.messages).length >= 2);
});

test('OpenRouter deepseek gets no markers, and its prefix is stable across rounds', () => {
  const cfg = {
    cache: true,
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'deepseek/deepseek-v3.2',
    systemPrompt: 'sys'
  };
  assert.deepEqual(marks(buildMessages(cfg, convo)), []);

  // The regression this guards: with markers on, the newest text message is
  // wrapped this round and unwrapped the next, so a message already sent once
  // serialises differently the second time and every hit after it is lost.
  const before = buildMessages(cfg, convo);
  const after = buildMessages(cfg, [...convo, { role: 'user', content: 'and again?' }]);
  assert.deepEqual(after.slice(0, before.length), before, 'the prefix may only be appended to');
});


/* ---------- local backends: layer 1 only ---------- */

const LOCAL = {
  cache: true,
  baseUrl: 'http://localhost:8080/v1',
  model: 'qwen3-coder-30b-a3b-instruct',
  systemPrompt: 'sys'
};

test('a local runtime gets plain string content and no cache fields', () => {
  const out = buildMessages(LOCAL, convo);
  assert.deepEqual(marks(out), [], 'array content is what strict local servers reject');
  assert.equal(typeof out[0].content, 'string');
  const body = buildBody(
    LOCAL,
    { turn: convo, tools: [], lastCall: false, epochIndex: 2, chatId: 'chat-1' },
    new Set()
  );
  assert.equal(body.cache_control, undefined);
  assert.equal(body.session_id, undefined, 'session_id is an OpenRouter field');
});

test('a local endpoint wins over a model name that looks like a hosted one', () => {
  // GGUF repacks keep the upstream name; the endpoint is what decides the wire.
  const out = buildMessages({ ...LOCAL, model: 'claude-sonnet-4.5-gguf' }, convo);
  assert.deepEqual(marks(out), []);
});

test('LAN addresses count as local', () => {
  assert.deepEqual(marks(buildMessages({ ...LOCAL, baseUrl: 'http://192.168.1.40:1234/v1' }, convo)), []);
});

test('cacheMode overrides the guess in both directions', () => {
  assert.ok(
    marks(buildMessages({ ...LOCAL, cacheMode: 'explicit' }, convo)).length >= 2,
    'a local server that does understand breakpoints can be told so'
  );
  assert.deepEqual(
    marks(buildMessages({ ...CLAUDE, cacheMode: 'implicit' }, convo)),
    [],
    'and a hosted one can be told to stop'
  );
});

test('an unknown gateway serving an unknown model stays on the safe path', () => {
  const cfg = { cache: true, baseUrl: 'https://gateway.internal/v1', model: 'house-model-v2', systemPrompt: 'sys' };
  const body = buildBody(
    cfg, { turn: convo, tools: [], lastCall: false, epochIndex: -1, chatId: 'c' }, new Set()
  );
  assert.deepEqual(marks(body.messages), []);
  assert.equal(body.cache_control, undefined);
  assert.equal(body.session_id, undefined);
});

/* ---------- tool budget ---------- */

test('the budget note counts down, warns near the end, and closes the door at zero', () => {
  const at = (round, max = 12) => budgetNote(round, max).content;

  assert.match(at(0), /12 rounds/, 'the opening note states the whole budget');
  assert.match(at(0), /one final round with tools disabled/, 'and that running out is not the end of the turn');
  assert.doesNotMatch(at(0), /stop broadening/, 'no warning while there is room');

  assert.match(at(1), /11 rounds of 12 remaining/);
  assert.match(at(5), /7 rounds of 12 remaining/);

  assert.match(at(10), /stop broadening/, 'two rounds left is the warning threshold');
  assert.match(at(11), /1 round of 12 remaining/, 'singular, not "1 rounds"');

  assert.match(at(12), /budget for this message is spent/);
  assert.match(at(12), /No further tool calls are possible/);

  // A budget small enough that the opening note is also the warning.
  assert.match(budgetNote(0, 2).content, /stop broadening/);
});

test('every budget note is a system message, so no breakpoint can land on it', () => {
  for (const round of [0, 1, 11, 12]) {
    assert.equal(budgetNote(round, 12).role, 'system');
    assert.equal(typeof budgetNote(round, 12).content, 'string');
  }
});

test('the budget note rides at the tail and leaves the cached prefix alone', () => {
  const cfg = { cache: true, baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', systemPrompt: 'sys' };
  // What two consecutive rounds of one turn actually put on the wire: the note
  // is appended to a copy, never stored, so round two rebuilds history without
  // round one's note.
  const roundOne = buildMessages(cfg, [...convo, budgetNote(0, 12)]);
  const grew = [...convo, { role: 'assistant', content: 'narration' }];
  const roundTwo = buildMessages(cfg, [...grew, budgetNote(1, 12)]);

  const shared = buildMessages(cfg, convo).length;
  assert.deepEqual(
    roundTwo.slice(0, shared),
    roundOne.slice(0, shared),
    'the history both rounds share must be byte-identical'
  );
  assert.equal(roundOne.at(-1).role, 'system', 'the note is last, not embedded in the history');
  assert.equal(roundTwo.at(-1).role, 'system');
});
