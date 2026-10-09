// A no-login install answers only to loopback names (DNS-rebinding guard).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { badHost } from '../src/http.js';

const dir = mkdtempSync(join(tmpdir(), 'tinywebui-host-'));
const { start } = await import('../src/server.js');
const srv = await start({
  port: 0, host: '127.0.0.1', configFile: false, mcpServers: {}, dbPath: join(dir, 'chats.db'),
  config: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'm', authMode: 'none', allowedHosts: ['Box.lan'] }
});
test.after(() => srv.shutdown());
const port = srv.address().port;

// fetch() won't let us set Host, so talk to the socket directly.
const status = (host) => new Promise((resolve, reject) => {
  http.get({ port, host: '127.0.0.1', path: '/api/auth/me', headers: { host } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
});

test('loopback names and allowedHosts are served', async () => {
  for (const h of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, `box.lan:${port}`]) {
    assert.notEqual(await status(h), 403, h);
  }
});

test('a rebound name is refused', async () => {
  for (const h of [`evil.com:${port}`, `127.0.0.1.evil.com:${port}`, `192.168.1.5:${port}`]) {
    assert.equal(await status(h), 403, h);
  }
});

test('logged-in modes are not host-restricted', () => {
  assert.equal(badHost({ headers: { host: 'chat.example.com' } }, { authMode: 'single' }), false);
});
