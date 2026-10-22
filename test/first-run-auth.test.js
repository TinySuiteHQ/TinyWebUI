import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULTS, createConfigSource, configProblems } from '../src/config/config.ts';
import { start } from '../src/server.js';

const dir = mkdtempSync(join(tmpdir(), 'tinywebui-first-run-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

test('a fresh start offers first-account setup without opening the app', async () => {
  assert.equal(DEFAULTS.authMode, 'multiuser');
  const srv = await start({ port: 0, configFile: false, mcpServers: {}, dbPath: ':memory:',
    config: { retrieval: { mode: 'lexical' } } });
  try {
    const base = `http://127.0.0.1:${srv.address().port}`;
    const me = await (await fetch(`${base}/api/auth/me`)).json();
    assert.equal(me.needsSetup, true);
    assert.equal(me.user, null);
    assert.equal((await fetch(`${base}/api/chats`)).status, 401);
  } finally { await srv.shutdown(); }
});

test('an old password environment variable cannot select local mode', () => {
  const previous = process.env.TINYWEBUI_PASSWORD;
  process.env.TINYWEBUI_PASSWORD = 'old password';
  try {
    const cfg = createConfigSource({ configFile: false }).load({ persistSecret: false });
    assert.equal(cfg.authMode, 'multiuser');
    assert.match(configProblems(cfg).join(), /TINYWEBUI_PASSWORD no longer selects password login/);
  } finally {
    if (previous === undefined) delete process.env.TINYWEBUI_PASSWORD;
    else process.env.TINYWEBUI_PASSWORD = previous;
  }
});

test('explicit local mode cannot bind to a network interface', async () => {
  await assert.rejects(start({ port: 0, host: '0.0.0.0', configFile: false, mcpServers: {}, dbPath: ':memory:',
    config: { authMode: 'local' } }), /limited to loopback/);
});
