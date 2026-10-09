import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS } from '../src/config/config.js';
import { start } from '../src/server.js';

const dir = mkdtempSync(join(tmpdir(), 'tinywebui-first-run-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

test('a fresh start needs a password only to leave loopback', async () => {
  assert.equal(DEFAULTS.authMode, 'single');
  await assert.rejects(start({ port: 0, host: '0.0.0.0', configFile: false, mcpServers: {}, dbPath: ':memory:' }), /needs a password on a network bind/);
});

test('a headless CLI start on a network bind refuses and exits', () => {
  const bin = fileURLToPath(new URL('../bin/tinywebui.js', import.meta.url));
  const result = spawnSync(process.execPath, [bin, 'start', '--port', '0', '--host', '0.0.0.0'], {
    cwd: dir, encoding: 'utf8', timeout: 5000,
    env: { ...process.env, TINYWEBUI_CONFIG: join(dir, 'config.json'), TINYWEBUI_RETRIEVAL_MODE: 'lexical', TINYWEBUI_PASSWORD: '' }
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /needs a password on a network bind/);
});

test('explicit no-login mode cannot bind to a network interface', async () => {
  await assert.rejects(start({ port: 0, host: '0.0.0.0', configFile: false, mcpServers: {}, dbPath: ':memory:',
    config: { authMode: 'none' } }), /limited to loopback/);
});
