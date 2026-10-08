// Starting an instance from code: no config file, no mcp.json, and the keys
// passed in are locked against the settings panel.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'tinywebui-codecfg-'));
// Point the file-based defaults somewhere empty, to prove none are touched.
process.env.TINYWEBUI_CONFIG = join(dir, 'config.json');
delete process.env.TINYWEBUI_MODEL;

const { start } = await import('../src/server.js');
const srv = await start({
  port: 0,
  host: '127.0.0.1',
  configFile: false,
  dbPath: ':memory:',
  config: { authMode: 'none', apiKey: 'k', model: 'code-model', toolApproval: 'all' },
  mcpServers: {},
});
const base = `http://127.0.0.1:${srv.address().port}`;
test.after(() => srv.shutdown());

const post = async (path, body) => {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
};

test('code values are in effect and reported as locked', async () => {
  const cfg = await (await fetch(`${base}/api/config`)).json();
  assert.equal(cfg.model, 'code-model');
  assert.equal(cfg.toolApproval, 'all');
  assert.equal(cfg.hasApiKey, true);
  assert.equal(cfg.apiKey, undefined);
  assert.deepEqual(cfg.lockedKeys.sort(), ['apiKey', 'authMode', 'model', 'toolApproval']);
  assert.equal(cfg.mcpLocked, true);
});

test('a locked key cannot be saved; an unlocked one lives in memory', async () => {
  assert.equal((await post('/api/config', { model: 'other' })).status, 409);
  const ok = await post('/api/config', { keepTurns: 5 });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.keepTurns, 5);
  assert.equal(ok.body.model, 'code-model');
  assert.equal(existsSync(process.env.TINYWEBUI_CONFIG), false, 'no config file written');
});

test('the MCP editor is read-only', async () => {
  const mcp = await (await fetch(`${base}/api/mcp`)).json();
  assert.equal(mcp.locked, true);
  assert.equal((await post('/api/mcp', { text: '{"mcpServers":{}}' })).status, 409);
});
