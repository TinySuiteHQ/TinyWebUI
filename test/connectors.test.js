// Connectors: named endpoints with their own keys. The keys live in the config
// file (so the file alone reproduces an instance) but are write-only over the
// API, admin-only to change, and never reach the page or the audit log.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configProblems, DEFAULTS } from '../src/config/config.ts';
import { effectiveConfig, flattenCatalog, nestCatalog } from '../src/config/models.ts';
import { fingerprint } from '../src/access/policy.ts';

const SECRET = 'sk-test-abcdef123456';

test('an entry runs against its connector; others keep the global endpoint', () => {
  const cfg = {
    ...DEFAULTS, baseUrl: 'http://global/v1', apiKey: 'global-key', model: 'a',
    connectors: [{ id: 'local', baseUrl: 'http://localhost:11434/v1/', apiKey: 'local-key' }],
    models: [{ id: 'a', model: 'vendor/a' }, { id: 'b', model: 'llama', connector: 'local' }]
  };
  assert.equal(effectiveConfig(cfg, 'a').baseUrl, 'http://global/v1');
  const b = effectiveConfig(cfg, 'b');
  assert.deepEqual([b.baseUrl, b.apiKey, b.model], ['http://localhost:11434/v1', 'local-key', 'llama']);
});

test('connector problems are named', () => {
  const bad = (extra) => configProblems({ ...DEFAULTS, authMode: 'local', ...extra });
  assert.match(bad({ connectors: [{ id: 'x', baseUrl: 'ftp://nope' }] }).join(), /baseUrl must be an http\(s\) URL/);
  assert.match(bad({ connectors: [{ id: 'x', baseUrl: 'http://h' }, { id: 'x', baseUrl: 'http://h' }] }).join(), /listed twice/);
  assert.match(bad({ models: [{ id: 'm', connector: 'missing' }] }).join(), /"missing" is not in connectors/);
  assert.match(bad({ models: [{ id: 'm', tags: ['telepathy'] }] }).join(), /tags must be a list/);
  assert.deepEqual(bad({ connectors: [{ id: 'x', baseUrl: 'http://h' }], models: [{ id: 'm', connector: 'x', tags: ['vision'] }], model: 'm' }), []);
});

test('the file nests models under their endpoint; runtime sees one flat list', () => {
  const file = {
    models: [{ id: 'a', model: 'vendor/a', systemPrompt: 'Be brief.' }],
    connectors: [{ id: 'local', baseUrl: 'http://localhost:11434/v1', models: [{ id: 'b', model: 'llama', temperature: 0.2 }] }]
  };
  const flat = flattenCatalog(file);
  assert.deepEqual(flat.models.map((m) => [m.id, m.connector]), [['a', undefined], ['b', 'local']]);
  assert.ok(!('models' in flat.connectors[0]));
  assert.deepEqual(nestCatalog(flat), file, 'nesting undoes flattening');
  const cfg = { ...DEFAULTS, model: 'b', ...flat };
  const b = effectiveConfig(cfg, 'b');
  assert.deepEqual([b.baseUrl, b.model, b.temperature], ['http://localhost:11434/v1', 'llama', 0.2]);
  assert.equal(effectiveConfig(cfg, 'a').systemPrompt, 'Be brief.');
  assert.deepEqual(configProblems({ ...DEFAULTS, authMode: 'local', model: 'b', ...file }), []);
  const bad = configProblems({ ...DEFAULTS, authMode: 'local', connectors: [{ id: 'x', baseUrl: 'http://h', models: { id: 'm' } }] });
  assert.match(bad.join(), /connectors\[0\]\.models must be a list/);
});

test('an old flat file still loads, and an entry naming an unknown connector stays flat', () => {
  const flat = { connectors: [{ id: 'x', baseUrl: 'http://h' }], models: [{ id: 'm', connector: 'x' }, { id: 'n', connector: 'gone' }] };
  assert.deepEqual(flattenCatalog(flat), flat);
  const nested = nestCatalog(flat);
  assert.deepEqual(nested.connectors[0].models, [{ id: 'm' }]);
  assert.deepEqual(nested.models, [{ id: 'n', connector: 'gone' }], 'validation still reports it');
});

test('a fingerprint never contains a connector key', () => {
  const a = fingerprint({ ...DEFAULTS, connectors: [{ id: 'x', baseUrl: 'http://h', apiKey: 'one' }] });
  const b = fingerprint({ ...DEFAULTS, connectors: [{ id: 'x', baseUrl: 'http://h', apiKey: 'two' }] });
  assert.equal(a, b, 'only whether a key is set counts');
  assert.notEqual(a, fingerprint({ ...DEFAULTS, connectors: [{ id: 'x', baseUrl: 'http://h' }] }));
});

const dir = mkdtempSync(join(tmpdir(), 'tinywebui-connectors-'));
const configFile = join(dir, 'tinywebui.config.json');
writeFileSync(configFile, JSON.stringify({ baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k' }));
writeFileSync(join(dir, 'mcp.json'), '{ "mcpServers": {} }\n');
const readCfg = () => JSON.parse(readFileSync(configFile, 'utf8'));
const readSecrets = () => JSON.parse(readFileSync(join(dir, 'tinywebui.secrets.json'), 'utf8'));

const logged = [];
const origLog = console.log;
console.log = (...args) => { logged.push(args.join(' ')); };
const { start } = await import('../src/server.ts');
const srv = await start({
  port: 0, host: '127.0.0.1', configFile, dbPath: join(dir, 'c.db'),
  config: {
    authMode: 'trusted-header', trustedProxyCidrs: ['127.0.0.1/32'],
    access: { bootstrapAdmins: ['sub-root'], roles: { user: { features: ['chat', 'settings'] } } }
  }
});
test.after(async () => { console.log = origLog; await srv.shutdown(); });

const as = (id) => async (path, { method = 'GET', body } = {}) => {
  const res = await fetch(`http://127.0.0.1:${srv.address().port}${path}`, {
    method, headers: { 'content-type': 'application/json', 'x-tinysuite-user-id': id }, body: body && JSON.stringify(body)
  });
  return { status: res.status, data: await res.json().catch(() => null), text: null };
};
const root = as('sub-root');
const user = as('sub-user');
const post = (who, body) => who('/api/config', { method: 'POST', body });

test('a key written into the config file moves to the secrets file on start', () => {
  assert.equal(readCfg().apiKey, undefined);
  assert.equal(readSecrets().apiKey, 'k');
  if (process.platform !== 'win32') assert.equal(statSync(join(dir, 'tinywebui.secrets.json')).mode & 0o777, 0o600);
});

test('an admin saves a connector: the key lands in the secrets file, never in the config, a response or the log', async () => {
  const r = await post(root, { connectors: [{ id: 'local', label: 'Local', baseUrl: 'http://localhost:11434/v1', apiKey: SECRET }] });
  assert.equal(r.status, 200);
  assert.equal(readSecrets().connectors.local.apiKey, SECRET);
  assert.ok(!readFileSync(configFile, 'utf8').includes(SECRET), 'the config file holds the shape only');
  assert.deepEqual(readCfg().connectors[0], { id: 'local', label: 'Local', baseUrl: 'http://localhost:11434/v1' });
  assert.ok(!JSON.stringify(r.data).includes(SECRET));
  const got = (await root('/api/config')).data;
  assert.ok(!JSON.stringify(got).includes(SECRET));
  assert.deepEqual([got.connectors[0].hasApiKey, got.connectors[0].keyHint], [true, '3456']);
  assert.ok(!logged.join('\n').includes(SECRET), 'audit redacts secrets');
});

test('a connector sent without a key keeps its key; null clears it', async () => {
  await post(root, { connectors: [{ id: 'local', baseUrl: 'http://localhost:11434/v1', label: 'Renamed' }] });
  assert.equal(readSecrets().connectors.local.apiKey, SECRET);
  assert.equal(readCfg().connectors[0].label, 'Renamed');
  await post(root, { connectors: [{ id: 'local', baseUrl: 'http://localhost:11434/v1', apiKey: null }] });
  assert.equal(readSecrets().connectors, undefined);
  assert.equal((await root('/api/config')).data.connectors[0].hasApiKey, false);
});

test('the top-level key follows the same rules', async () => {
  await post(root, { apiKey: 'sk-top-level-key-9999' });
  assert.equal(readSecrets().apiKey, 'sk-top-level-key-9999');
  assert.equal(readCfg().apiKey, undefined);
  await post(root, { apiKey: '' });
  assert.equal(readSecrets().apiKey, 'sk-top-level-key-9999', 'empty means unchanged');
});

test('a key can point at the environment instead; the page cannot overwrite it', async () => {
  process.env.TINYWEBUI_TEST_CONNECTOR_KEY = 'sk-from-the-environment';
  try {
    const r = await post(root, { connectors: [{ id: 'env', baseUrl: 'http://localhost:1/v1', apiKey: '${TINYWEBUI_TEST_CONNECTOR_KEY}' }] });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(readCfg().connectors[0].apiKey, '${TINYWEBUI_TEST_CONNECTOR_KEY}', 'a reference is shape, so the config holds it');
    assert.equal(readSecrets().connectors, undefined);
    assert.equal((await root('/api/config')).data.connectors[0].keyHint, 'ment');
    const typed = await post(root, { connectors: [{ id: 'env', baseUrl: 'http://localhost:1/v1', apiKey: 'sk-typed-in' }] });
    assert.equal(typed.status, 409);
    assert.match(typed.data.error, /comes from \$\{TINYWEBUI_TEST_CONNECTOR_KEY\}/);
    assert.equal((await post(root, { connectors: [{ id: 'env', baseUrl: 'http://localhost:1/v1', apiKey: '${NOT_SET_ANYWHERE_X}' }] })).status, 400);
  } finally {
    delete process.env.TINYWEBUI_TEST_CONNECTOR_KEY;
    await post(root, { connectors: [] });
  }
});

test('a saved catalog is written nested under its connector, and read back flat', async () => {
  await post(root, { connectors: [{ id: 'local', baseUrl: 'http://localhost:11434/v1', apiKey: SECRET }] });
  const r = await post(root, {
    connectors: [{ id: 'local', baseUrl: 'http://localhost:11434/v1' }],
    models: [{ id: 'a', model: 'vendor/a' }, { id: 'b', model: 'llama', connector: 'local', cacheTtl: '1h' }],
    model: 'a'
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const file = readCfg();
  assert.deepEqual(file.models, [{ id: 'a', model: 'vendor/a' }]);
  assert.deepEqual(file.connectors[0].models, [{ id: 'b', model: 'llama', cacheTtl: '1h' }]);
  assert.equal(readSecrets().connectors.local.apiKey, SECRET, 'the key survives the reshaping');
  const got = (await root('/api/config')).data;
  assert.deepEqual(got.models.map((m) => [m.id, m.connector]), [['a', undefined], ['b', 'local']]);
  assert.ok(!('models' in got.connectors[0]));
  // Back to no catalog, so later tests see the open default.
  await post(root, { models: [], connectors: [], model: DEFAULTS.model });
});

test('a role with the settings feature cannot touch credentials or see connectors', async () => {
  assert.equal((await post(user, { systemPrompt: 'mine' })).status, 200);
  for (const body of [{ apiKey: 'x' }, { baseUrl: 'http://evil/v1' }, { connectors: [] }, { models: [] }]) {
    const r = await post(user, body);
    assert.equal(r.status, 403, JSON.stringify(body));
    assert.match(r.data.error, /only an admin/);
  }
  const seen = (await user('/api/config')).data;
  for (const k of ['connectors', 'baseUrl', 'keyHint', 'apiKey']) assert.ok(!(k in seen), `${k} hidden from non-admins`);
});
