// Local MCP servers TinyWebUI starts over HTTP (src/mcp_serve.ts): one
// process for everyone, a connection per user, and every request proven
// with a token only TinyWebUI holds -- checked against a real child process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpHub } from '../src/mcp.ts';
import { serveProblems } from '../src/mcp_serve.ts';
import { identityProblems } from '../src/access/mcp_identity.ts';

const FIXTURE = fileURLToPath(new URL('./mcp-served-fixture.js', import.meta.url));
const as = (userId) => ({ store: null, chatId: 'c', budget: 8000, unattended: false, askUser: null, userId });
const principal = (userId) => (userId ? `user:${userId}` : null);

const spec = (extra = {}) => ({
  command: process.execPath,
  args: [FIXTURE],
  env: { FX_DATA: '${TINYWEBUI_DATA_DIR}/mcp/fx' },
  serve: { proxyToken: { env: 'FX_PROXY_TOKEN', header: 'X-Fx-Proxy-Token' }, managementToken: 'FX_MANAGEMENT_TOKEN', secrets: ['FX_SECRET'] },
  identity: { header: 'X-Fx-User' },
  ...extra
});

function servedHub(t, { secrets = new Map(), servers = { fx: spec() } } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'twui-serve-'));
  const secret = (server, name) => {
    const key = `${server}/${name}`;
    if (!secrets.has(key)) secrets.set(key, `${name.toLowerCase()}-${secrets.size + 1}`);
    return secrets.get(key);
  };
  const hub = new McpHub(servers, { principal, dataDir, secret });
  t.after(() => hub.close());
  return { hub, dataDir, secrets };
}

const whoami = async (hub, userId) => JSON.parse(await hub.call('fx__whoami', {}, as(userId)));
const until = (promise, ms = 10_000) => Promise.race([promise, new Promise((_, no) => setTimeout(() => no(new Error('timed out')), ms))]);

test('serve is refused without a command, with a url, or with names TinyWebUI owns', () => {
  const problems = (s) => serveProblems('m', s).join('; ');
  assert.equal(problems(spec()), '');
  assert.match(problems({ url: 'http://x/mcp', serve: {} }), /needs a "command"/);
  assert.match(problems({ command: 'x', url: 'http://x/mcp', serve: {} }), /cannot be used with "url"/);
  assert.match(problems({ command: 'x', serve: { proxyToken: { env: 'MCP_PORT', header: 'X-T' } } }), /TinyWebUI sets it/);
  assert.match(problems({ command: 'x', serve: { proxyToken: { env: 'T', header: 'bad header' } } }), /header name/);
  assert.match(problems(spec({ serve: { proxyToken: { env: 'T', header: 'X-Fx-User' } } })), /cannot be the identity header/);
  assert.match(problems({ command: 'x', serve: { secrets: 'S' } }), /list of environment variable names/);
  assert.match(problems({ command: 'x', serve: { other: 1 } }), /not a known setting/);
  assert.match(problems({ command: 'x', env: { MCP_HOST: '0.0.0.0' }, serve: {} }), /set by TinyWebUI/);
  // A served server is reached over HTTP, so it may separate users.
  assert.deepEqual(identityProblems('m', spec()), []);
  assert.match(identityProblems('m', { command: 'x', identity: { header: 'X-U' } }).join(), /needs an HTTP server/);
});

test('one process serves everyone, each user on their own connection, every request with the proxy token', async (t) => {
  const { hub, dataDir } = servedHub(t);
  await hub.connect();
  assert.deepEqual(hub.errors, []);
  assert.ok(hub.tools.some((tool) => tool.function.name === 'fx__whoami'));

  const [alice, bob] = await Promise.all([whoami(hub, 'alice'), whoami(hub, 'bob')]);
  assert.equal(alice.user, 'user:alice');
  assert.equal(bob.user, 'user:bob');
  assert.equal(alice.pid, bob.pid, 'one server process');
  assert.equal(alice.management, false, 'a user\'s connection never carries the management token');
  assert.equal(alice.secret, 'fx_secret-1');
  assert.equal(alice.data, `${dataDir}/mcp/fx`, '${TINYWEBUI_DATA_DIR} is TinyWebUI\'s own folder');

  const shared = JSON.parse(await hub.readResourceAs('fx', 'fx://who', { shared: true }));
  assert.equal(shared.management, true, 'the server-wide connection does');
  assert.equal(shared.user, 'urn:tinywebui:discovery');

  // Anything else on the machine can reach the port, but not pose as TinyWebUI.
  const { url } = await hub.served.get('fx');
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  const forged = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-fx-user': 'user:alice' }, body: '{}' });
  assert.equal(forged.status, 401);
});

test('a stored secret is the same on every launch; the proxy token is new each time', async (t) => {
  const secrets = new Map();
  const first = servedHub(t, { secrets });
  await first.hub.connect();
  const before = await whoami(first.hub, 'alice');
  const firstToken = (await first.hub.served.get('fx')).headers['X-Fx-Proxy-Token'];
  await first.hub.close();

  const second = servedHub(t, { secrets });
  await second.hub.connect();
  const after = await whoami(second.hub, 'alice');
  assert.equal(after.secret, before.secret);
  assert.notEqual(after.pid, before.pid);
  assert.notEqual((await second.hub.served.get('fx')).headers['X-Fx-Proxy-Token'], firstToken);
  assert.match(firstToken, /^[0-9a-f]{64}$/);
});

test('the server stops with the hub, and is started again after it dies', async (t) => {
  const { hub } = servedHub(t);
  await hub.connect();
  const before = await whoami(hub, 'alice');
  const running = await hub.served.get('fx');
  await hub.call('fx__crash', {}, as('alice'));
  await until(running.exited);
  const after = await whoami(hub, 'alice');
  assert.equal(after.user, 'user:alice');
  assert.notEqual(after.pid, before.pid, 'a new process');

  const current = await hub.served.get('fx');
  await hub.close();
  await until(current.exited);
  assert.ok(current.child.exitCode !== null || current.child.signalCode !== null);
});

test('a server that cannot start says why, and is not connected', async (t) => {
  const { hub } = servedHub(t, { servers: { broken: { command: process.execPath, args: ['-e', 'console.error("no such module"); process.exit(5)'], serve: {} } } });
  await hub.connect();
  assert.equal(hub.tools.length, 0);
  assert.match(hub.errors.join(), /broken: could not start: exited before it was ready \(code 5\): no such module/);
});
