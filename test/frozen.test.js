// Issue #2: strict validation, frozen deployments, and deployment metadata.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configProblems, DEFAULTS } from '../src/config.js';

const { start } = await import('../src/server.js');
const dir = mkdtempSync(join(tmpdir(), 'tinywebui-frozen-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));
const base = { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k' };

test('unknown keys and bad values are named, not silently defaulted', () => {
  const problems = configProblems({ ...DEFAULTS, sytemPrompt: 'typo', authMode: 'singel', maxToolRounds: 'ten', temperature: 'hot', cacheTtl: '2h', frozen: 'yes' }).join('\n');
  for (const needle of ['unknown setting "sytemPrompt"', 'authMode must be one of', 'maxToolRounds must be a number', 'temperature must be a number or null', 'cacheTtl must be one of', 'frozen must be true or false']) {
    assert.ok(problems.includes(needle), needle);
  }
  assert.deepEqual(configProblems({ ...DEFAULTS, temperature: 0.2, maxTokens: null }), []);
});

test('startup refuses an invalid config', async () => {
  await assert.rejects(start({ port: 0, configFile: false, mcpServers: {}, dbPath: ':memory:', config: { ...base, authMode: 'singel' } }), /authMode must be one of/);
  await assert.rejects(start({ port: 0, configFile: false, mcpServers: {}, dbPath: ':memory:', config: { ...base, colour: 'red' } }), /unknown setting "colour"/);
});

test('a frozen deployment cannot drift through the UI or API', async () => {
  const configFile = join(dir, 'tinywebui.config.json');
  writeFileSync(configFile, JSON.stringify({ systemPrompt: 'declared', frozen: true }));
  writeFileSync(join(dir, 'mcp.json'), '{ "mcpServers": {} }');
  const srv = await start({ port: 0, host: '127.0.0.1', configFile, dbPath: join(dir, 'db'), config: base });
  try {
    const url = `http://127.0.0.1:${srv.address().port}`;
    const post = (path, body) => fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post('/api/config', { systemPrompt: 'drift' })).status, 409);
    assert.equal((await post('/api/tools/toggle', { name: 'x', disabled: true })).status, 409);
    assert.equal((await post('/api/tools/approval', { name: 'x', policy: 'auto' })).status, 409);
    assert.equal((await post('/api/mcp', { text: '{"mcpServers":{}}' })).status, 409);
    assert.equal(JSON.parse(readFileSync(configFile, 'utf8')).systemPrompt, 'declared');

    const cfg = await (await fetch(`${url}/api/config`)).json();
    assert.equal(cfg.mcpLocked, true);
    assert.ok(cfg.lockedKeys.includes('systemPrompt'), 'the UI shows everything as managed');
    assert.equal((await (await fetch(`${url}/api/mcp`)).json()).locked, true);

    // User-owned data stays mutable.
    assert.equal((await post('/api/folders', { name: 'mine' })).status, 200);

    const meta = await (await fetch(`${url}/api/meta`)).json();
    assert.equal(meta.configMode, 'frozen');
    assert.equal(meta.authMode, 'none');
    assert.match(meta.version, /^\d+\.\d+\.\d+/);
    assert.match(meta.fingerprint, /^[0-9a-f]{16}$/);
    assert.equal(typeof meta.schemaVersion, 'number');
    assert.deepEqual(meta.mcpServers, []);
    assert.ok(!JSON.stringify(meta).includes('"k"'), 'no secrets');
  } finally { await srv.shutdown(); }
});

test('not frozen: the same deployment stays editable', async () => {
  const srv = await start({ port: 0, host: '127.0.0.1', configFile: false, mcpServers: {}, dbPath: ':memory:', config: base });
  try {
    const url = `http://127.0.0.1:${srv.address().port}`;
    const r = await fetch(`${url}/api/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"systemPrompt":"ok"}' });
    assert.equal(r.status, 200);
    assert.equal((await (await fetch(`${url}/api/meta`)).json()).configMode, 'editable');
  } finally { await srv.shutdown(); }
});
