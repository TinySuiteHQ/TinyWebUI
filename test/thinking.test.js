// Thinking levels: an admin sets them per model, a person picks among the
// ones offered, and each provider gets the level in the field it reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { trustedServer } from './trusted-helpers.js';
import { buildBody, thinkingStyle } from '../src/harness/provider.ts';
import { configProblems } from '../src/config/config.ts';
import { thinkingFor, thinkingView } from '../src/config/models.ts';

const plan = { turn: [{ role: 'user', content: 'hi' }], tools: [], lastCall: false, epochIndex: -1, chatId: 'c' };
const body = (cfg) => buildBody({ systemPrompt: 'S', model: 'm', ...cfg }, plan, new Set());

test('each endpoint gets the level in the field it reads', () => {
  const effort = body({ baseUrl: 'https://api.openai.com/v1', thinkingLevel: 'high' });
  assert.equal(effort.reasoning_effort, 'high');
  assert.equal(body({ baseUrl: 'http://127.0.0.1:11434/v1', thinkingLevel: 'off' }).reasoning_effort, 'none');

  const or = body({ baseUrl: 'https://openrouter.ai/api/v1', thinkingLevel: 'low', extraBody: { reasoning: { exclude: true } } });
  assert.deepEqual(or.reasoning, { exclude: true, effort: 'low' }, 'reasoning settings from extraBody survive');
  assert.equal(or.reasoning_effort, undefined);

  const claude = body({ baseUrl: 'https://api.anthropic.com/v1', thinkingLevel: 'medium' });
  assert.deepEqual(claude.thinking, { type: 'enabled', budget_tokens: 8192 });
  assert.ok(claude.max_tokens > 8192, 'the budget fits under max_tokens');
  assert.equal(body({ baseUrl: 'https://api.anthropic.com/v1', thinkingLevel: 'low', maxTokens: 30000 }).max_tokens, 30000, 'a roomy max_tokens is kept');
  assert.deepEqual(body({ baseUrl: 'https://api.anthropic.com/v1', thinkingLevel: 'off' }).thinking, { type: 'disabled' });

  const qwen = body({ baseUrl: 'http://127.0.0.1:8000/v1', thinkingLevel: 'off', thinkingSend: 'switch' });
  assert.deepEqual(qwen.chat_template_kwargs, { enable_thinking: false });
  assert.equal(thinkingStyle({ baseUrl: 'https://openrouter.ai/api/v1', thinkingSend: 'effort' }), 'effort', 'send overrides the guess');

  const none = body({ baseUrl: 'https://api.openai.com/v1' });
  for (const k of ['reasoning_effort', 'reasoning', 'thinking', 'chat_template_kwargs']) assert.equal(none[k], undefined, `${k} is not sent without a level`);
  const refused = buildBody({ systemPrompt: 'S', model: 'm', baseUrl: 'https://api.openai.com/v1', thinkingLevel: 'high' }, plan, new Set(['thinking']));
  assert.equal(refused.reasoning_effort, undefined, 'a refused field stays dropped');
});

test('a person gets a level the model offers, else its default; fixed when there is one choice', () => {
  const cfg = { model: 'deep', models: [
    { id: 'deep', thinking: { default: 'medium', choices: ['off', 'medium', 'high'] } },
    { id: 'fixed', thinking: { default: 'high' } },
    { id: 'plain' }
  ] };
  assert.deepEqual(thinkingFor(cfg, 'deep', 'high'), { level: 'high', send: 'auto' });
  assert.equal(thinkingFor(cfg, 'deep', 'low').level, 'medium', 'a level not offered falls back to the default');
  assert.equal(thinkingFor(cfg, 'deep', 'nonsense').level, 'medium');
  assert.equal(thinkingFor(cfg, 'fixed', 'off').level, 'high');
  assert.deepEqual(thinkingView(cfg.models[1].thinking), { default: 'high', choices: ['high'] });
  assert.equal(thinkingFor(cfg, 'plain', 'high'), null, 'a model without thinking settings sends nothing');

  // `provider` sends nothing, and is what an entry gets when it names no default.
  const open = { models: [{ id: 'open', thinking: { choices: ['provider', 'low', 'high'] } }, { id: 'bare', thinking: {} }, { id: 'nodef', thinking: { choices: ['off', 'medium', 'high'] } }] };
  assert.deepEqual(thinkingView(open.models[0].thinking), { default: 'provider', choices: ['provider', 'low', 'high'] });
  assert.equal(thinkingFor(open, 'open'), null, 'the default asks for nothing');
  assert.equal(thinkingFor(open, 'open', 'provider'), null);
  assert.deepEqual(thinkingFor(open, 'open', 'high'), { level: 'high', send: 'auto' });
  assert.equal(thinkingView(open.models[1].thinking), null, 'only the provider default: nothing to pick or send');
  assert.equal(thinkingView({ default: 'provider' }), null);
  assert.equal(thinkingView(open.models[2].thinking).default, 'medium', 'without provider among the choices, medium is the fallback');
  assert.deepEqual(configProblems({ models: [{ id: 'p', thinking: { default: 'provider', choices: ['provider', 'high'] } }] }), []);

  const errs = configProblems({ models: [{ id: 'a', thinking: { default: 'max', choices: ['low', 'huge'], send: 'smoke', budget: 1 } }, { id: 'b', thinking: { default: 'high', choices: ['low'] } }] }).join('\n');
  for (const needle of ['thinking.default must be', 'thinking.choices must be', 'thinking.send must be', 'thinking.budget is not', '"high" must be one of its choices']) assert.match(errs, new RegExp(needle), needle);
});

const sent = [];
const fake = createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    if (req.url.endsWith('/models')) { res.writeHead(404); return res.end(); }
    sent.push(JSON.parse(raw));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
});
const port = await new Promise((r) => fake.listen(0, '127.0.0.1', () => r(fake.address().port)));
const s = await trustedServer({
  baseUrl: `http://127.0.0.1:${port}/v1`, model: 'deep',
  models: [{ id: 'deep', thinking: { default: 'medium', choices: ['low', 'medium', 'high'] } }]
});
test.after(async () => { await s.srv.shutdown(); fake.close(); });

test('the pick sent with a message reaches the provider, within what the model allows', async () => {
  const me = (await s.as({ id: 'sub-t' })('/api/auth/me')).data;
  assert.deepEqual(me.thinking, { default: 'medium', choices: ['low', 'medium', 'high'] });
  const chat = async (thinking) => {
    const res = await fetch(`${s.base}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-tinysuite-user-id': 'sub-t' },
      body: JSON.stringify({ message: 'think', ...(thinking === undefined ? {} : { thinking }) })
    });
    await res.text();
    return sent.at(-1).reasoning_effort;
  };
  assert.equal(await chat('high'), 'high');
  assert.equal(await chat(undefined), 'medium');
  assert.equal(await chat('off'), 'medium', 'a level the admin did not offer is not sent');
});

// A provider that rejects the thinking field outright.
const seen = [];
const picky = createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    if (req.url.endsWith('/models')) { res.writeHead(404); return res.end(); }
    const b = JSON.parse(raw);
    seen.push(b);
    if (b.reasoning_effort) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Unrecognized request argument supplied: reasoning_effort' } }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
});
const pickyPort = await new Promise((r) => picky.listen(0, '127.0.0.1', () => r(picky.address().port)));
const p = await trustedServer({
  baseUrl: `http://127.0.0.1:${pickyPort}/v1`, model: 'deep',
  models: [{ id: 'deep', thinking: { default: 'medium', choices: ['provider', 'off', 'low', 'medium', 'high'] } }]
});
test.after(async () => { await p.srv.shutdown(); picky.close(); });
const send = async (thinking = 'high') => {
  const before = seen.length;
  const res = await fetch(`${p.base}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-tinysuite-user-id': 'sub-u' },
    body: JSON.stringify({ message: 'hi', thinking })
  });
  await res.text();
  return seen.slice(before);
};

test('picking the provider default sends no thinking field', async () => {
  assert.deepEqual((await send('provider')).map((b) => b.reasoning_effort), [undefined], 'one request, nothing to drop');
});

test('a rejected thinking field is dropped for that turn and still sent on the next one', async () => {
  assert.deepEqual((await send()).map((b) => b.reasoning_effort), ['high', undefined], 'rejected once, retried without it');
  assert.deepEqual((await send('low')).map((b) => b.reasoning_effort), ['low', undefined], 'nothing is remembered between turns');
});
