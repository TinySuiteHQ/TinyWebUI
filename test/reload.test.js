// Hand or agent edits to config.json / mcp.json take effect without a
// restart -- and a broken edit changes nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashPassword } from '../src/access/auth.js';

const dir = mkdtempSync(join(tmpdir(), 'tinywebui-reload-'));
const configFile = join(dir, 'tinywebui.config.json');
writeFileSync(configFile, JSON.stringify({ authMode: 'none', systemPrompt: 'v1' }));
writeFileSync(join(dir, 'mcp.json'), '{ "mcpServers": {} }\n');

const { start } = await import('../src/server.js');
const srv = await start({
  port: 0, host: '127.0.0.1', configFile, dbPath: join(dir, 'db'),
  config: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'frozen' }
});
test.after(async () => { await srv.shutdown(); rmSync(dir, { recursive: true, force: true }); });
const base = `http://127.0.0.1:${srv.address().port}`;
const cfg = async () => (await fetch(`${base}/api/config`)).json();
const edit = (obj) => writeFileSync(configFile, JSON.stringify({ authMode: 'none', ...obj }, null, 2));

test('a valid edit applies on reload', async () => {
  edit({ systemPrompt: 'v2' });
  assert.equal(await srv.reload('test'), true);
  assert.equal((await cfg()).systemPrompt, 'v2');
});

test('an invalid edit is rejected and nothing changes', async () => {
  edit({ systemPrompt: 'v3', access: { roles: { user: { features: ['teleport'] } } } });
  assert.equal(await srv.reload('test'), false);
  assert.equal((await cfg()).systemPrompt, 'v2');
  writeFileSync(configFile, '{ not json');
  assert.equal(await srv.reload('test'), false);
  assert.equal((await cfg()).systemPrompt, 'v2');
});

test('authMode cannot change without a restart', async () => {
  edit({ systemPrompt: 'v4', authMode: 'single', authPassword: hashPassword('a long test password') });
  assert.equal(await srv.reload('test'), false);
  assert.equal((await cfg()).authMode, 'none');
});

test('keys frozen in code stay frozen through a reload', async () => {
  edit({ systemPrompt: 'v5', model: 'sneaky' });
  assert.equal(await srv.reload('test'), true);
  const c = await cfg();
  assert.equal(c.systemPrompt, 'v5');
  assert.equal(c.model, 'frozen');
});

test('the file watch picks up an edit on its own', async () => {
  edit({ systemPrompt: 'watched' });
  const deadline = Date.now() + 5000;
  while ((await cfg()).systemPrompt !== 'watched') {
    if (Date.now() > deadline) assert.fail('watch did not reload within 5s');
    await new Promise((r) => setTimeout(r, 100));
  }
});

test('a broken mcp.json keeps the running servers', async () => {
  writeFileSync(join(dir, 'mcp.json'), '{ "mcpServers": { "bad": {} } }');
  assert.equal(await srv.reload('test'), false);
  assert.equal(JSON.parse(readFileSync(configFile, 'utf8')).systemPrompt, 'watched');
});
