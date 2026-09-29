// The model catalog: a closed list of models with people-facing labels and
// their own prompts and settings, enforced on the picker and on every turn.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { trustedServer } from './trusted-helpers.js';
import { configProblems, DEFAULTS } from '../src/config/config.js';
import { effectiveConfig } from '../src/config/models.js';

const seen = [];
const fake = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    if (req.url.endsWith('/models')) { res.writeHead(404); return res.end(); }
    seen.push(JSON.parse(body));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
});
const port = await new Promise((r) => fake.listen(0, '127.0.0.1', () => r(fake.address().port)));

const models = [
  { id: 'quick', label: 'Quick', description: 'Everyday questions', model: 'vendor/small-v1', temperature: 0.2, extraBody: { reasoning: { effort: 'low' } } },
  { id: 'deep', label: 'Thorough', model: 'vendor/large-v2', systemPrompt: 'You are the deep one.' },
  { id: 'secret', label: 'Admins only', model: 'vendor/huge' },
  { id: 'parked', label: 'Parked', model: 'vendor/old', enabled: false }
];
const { srv, as } = await trustedServer({
  baseUrl: `http://127.0.0.1:${port}/v1`, model: 'quick', models, extraBody: { provider: { sort: 'price' } },
  access: { roles: { user: { features: ['chat', 'model-picker'], models: ['quick', 'deep', 'parked'] } } }
});
test.after(async () => { await srv.shutdown(); fake.close(); });
const alice = as({ id: 'sub-alice' });

const chat = async (message) => {
  const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-tinysuite-user-id': 'sub-alice' }, body: JSON.stringify({ message })
  });
  await res.text();
};

test('the picker lists the role\'s catalog entries by label, never provider ids', async () => {
  const out = (await alice('/api/models')).data;
  assert.equal(out.catalog, true);
  assert.deepEqual(out.models, [
    { id: 'quick', name: 'Quick', description: 'Everyday questions' },
    { id: 'deep', name: 'Thorough', description: null }
  ]);
  assert.equal(JSON.stringify(out).includes('vendor/'), false);
  const me = (await alice('/api/auth/me')).data;
  assert.equal(me.model, 'quick');
  assert.equal(me.modelLabel, 'Quick');
});

test('picks outside the catalog or the role are refused', async () => {
  assert.equal((await alice('/api/me/prefs', { method: 'POST', body: { model: 'vendor/whatever' } })).status, 403);
  assert.equal((await alice('/api/me/prefs', { method: 'POST', body: { model: 'secret' } })).status, 403);
});

test('turns use the entry\'s provider id, prompt and settings', async () => {
  await chat('hi');
  let body = seen.at(-1);
  assert.equal(body.model, 'vendor/small-v1');
  assert.equal(body.temperature, 0.2);
  assert.deepEqual(body.reasoning, { effort: 'low' });
  assert.deepEqual(body.provider, { sort: 'price' }, 'extraBody merges over the global one');

  assert.equal((await alice('/api/me/prefs', { method: 'POST', body: { model: 'deep' } })).data.model, 'deep');
  await chat('again');
  body = seen.at(-1);
  assert.equal(body.model, 'vendor/large-v2');
  assert.equal(body.temperature, undefined);
  assert.match(body.messages[0].content, /You are the deep one\./);
});

test('the catalog is validated, and everything that names a model must name an entry', () => {
  const base = { ...DEFAULTS, models };
  assert.deepEqual(configProblems({ ...base, model: 'quick' }), []);
  assert.deepEqual(configProblems({ ...base, model: 'vendor/large-v2' }), [], 'a provider id finds its entry');
  assert.match(configProblems({ ...base, model: 'nope' }).join(), /not in the models catalog/);
  assert.match(configProblems({ ...base, model: 'quick', access: { roles: { user: { models: ['ghost'] } } } }).join(), /"ghost" is not a models catalog id/);
  assert.match(configProblems({ ...base, model: 'quick', models: [{ id: 'a', tempurature: 1 }] }).join(), /tempurature is not a known setting/);
  assert.match(configProblems({ ...base, model: 'a', models: [{ id: 'a' }, { id: 'a' }] }).join(), /listed twice/);
  assert.deepEqual(configProblems({ ...DEFAULTS }), [], 'no catalog: nothing changes');
});

test('effectiveConfig leaves unknown ids alone when there is no catalog', () => {
  assert.equal(effectiveConfig({ ...DEFAULTS, model: 'a' }, 'b').model, 'b');
  assert.equal(effectiveConfig({ ...DEFAULTS, model: 'a' }, null).model, 'a');
});

test('a disabled entry is hidden, refused and cannot be the default', () => {
  assert.deepEqual(effectiveConfig({ ...DEFAULTS, models, model: 'quick' }, 'parked').model, 'parked', 'never resolves to its provider id');
  const base = { ...DEFAULTS, models };
  assert.match(configProblems({ ...base, model: 'parked' }).join(), /"parked" is disabled/);
  assert.match(configProblems({ ...base, model: 'x', models: [{ id: 'x', enabled: false }] }).join(), /every entry in models is disabled/);
  assert.match(configProblems({ ...base, model: 'quick', models: [{ id: 'quick', enabled: 'no' }] }).join(), /enabled must be true or false/);
});

test('the picker and prefs skip disabled entries', async () => {
  assert.equal((await alice('/api/models')).data.models.some((m) => m.id === 'parked'), false);
  assert.equal((await alice('/api/me/prefs', { method: 'POST', body: { model: 'parked' } })).status, 403);
});
