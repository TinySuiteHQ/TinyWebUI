// Keys live in tinywebui.secrets.json or the environment, never in the config
// file, which only says what the deployment is (see src/config/secrets.ts).
// The database, which holds every conversation, is owner-only too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfigSource, configProblems, DEFAULTS } from '../src/config/config.ts';
import { Store } from '../src/store/index.ts';

const setup = (config) => {
  const dir = mkdtempSync(join(tmpdir(), 'tinywebui-secrets-'));
  const configFile = join(dir, 'tinywebui.config.json');
  writeFileSync(configFile, JSON.stringify(config));
  const read = (name) => JSON.parse(readFileSync(join(dir, name), 'utf8'));
  return { dir, configFile, source: createConfigSource({ configFile, mcpServers: {} }), read };
};

test('the generated session secret goes to the secrets file, not the config', () => {
  const { source, read, dir } = setup({ authMode: 'multiuser' });
  const cfg = source.load();
  assert.match(cfg.sessionSecret, /^[0-9a-f]{64}$/);
  assert.equal(read('tinywebui.config.json').sessionSecret, undefined);
  assert.equal(read('tinywebui.secrets.json').sessionSecret, cfg.sessionSecret);
  if (process.platform !== 'win32') assert.equal(statSync(join(dir, 'tinywebui.secrets.json')).mode & 0o777, 0o600);
  assert.equal(source.load().sessionSecret, cfg.sessionSecret, 'and is read back from there');
});

test('a read-only load uses keys in the config file but moves nothing', () => {
  const { source, read, dir } = setup({ apiKey: 'sk-in-the-file', connectors: [{ id: 'c', baseUrl: 'http://h/v1', apiKey: 'sk-conn' }] });
  const cfg = source.load({ persistSecret: false });
  assert.equal(cfg.apiKey, 'sk-in-the-file');
  assert.equal(cfg.connectors[0].apiKey, 'sk-conn');
  assert.equal(read('tinywebui.config.json').apiKey, 'sk-in-the-file');
  assert.equal(existsSync(join(dir, 'tinywebui.secrets.json')), false);
  assert.deepEqual(source.secretsInFile(), ['apiKey', 'connectors.c.apiKey']);
});

test('a reference is filled from the environment, and an unset one is a problem', () => {
  const { source } = setup({ apiKey: '${TINYWEBUI_TEST_TOP_KEY}' });
  process.env.TINYWEBUI_TEST_TOP_KEY = 'sk-env';
  try {
    assert.equal(source.load().apiKey, 'sk-env');
    assert.deepEqual(source.secretsInFile(), [], 'a reference is not a secret');
  } finally { delete process.env.TINYWEBUI_TEST_TOP_KEY; }
  const unset = source.load();
  assert.equal(unset.apiKey, '${TINYWEBUI_TEST_TOP_KEY}');
  assert.ok(configProblems(unset).some((p) => /apiKey refers to \$\{TINYWEBUI_TEST_TOP_KEY\}, which is not set/.test(p)));
});

test('a frozen deployment keeps its keys where they are', () => {
  const { source, read, dir } = setup({ frozen: true, authMode: 'local', apiKey: 'sk-frozen' });
  assert.equal(source.load().apiKey, 'sk-frozen');
  assert.equal(read('tinywebui.config.json').apiKey, 'sk-frozen');
  assert.equal(existsSync(join(dir, 'tinywebui.secrets.json')), false);
});

test('the defaults name no secret value', () => {
  for (const k of ['apiKey', 'sessionSecret', 'googleClientSecret', 'authPassword']) assert.equal(DEFAULTS[k], '');
});

test('the database is created owner-only, and an existing one is tightened', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'tinywebui-dbmode-'));
  const fresh = join(dir, 'fresh.db');
  const store = new Store(fresh);
  store.chats.create({ title: 'x' });
  for (const p of [fresh, `${fresh}-wal`]) assert.equal(statSync(p).mode & 0o777, 0o600, p);
  store.close();

  const old = join(dir, 'old.db');
  new Store(old).close();
  chmodSync(old, 0o644);
  new Store(old).close();
  assert.equal(statSync(old).mode & 0o777, 0o600);
});

test('mcp.json saved from the editor is owner-only', { skip: process.platform === 'win32' }, () => {
  const { dir } = setup({ authMode: 'local' });
  const mcpFile = join(dir, 'mcp.json');
  writeFileSync(mcpFile, '{}', { mode: 0o644 });
  createConfigSource({ configFile: join(dir, 'tinywebui.config.json') }).saveMcpFile('{ "mcpServers": { "a": { "url": "http://h/mcp", "headers": { "Authorization": "Bearer t" } } } }');
  assert.equal(statSync(mcpFile).mode & 0o777, 0o600);
});
