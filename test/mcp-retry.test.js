// A remote MCP server that is not up when the hub connects -- still starting
// after a reboot, say -- is retried on its own and can be retried by hand.
import test from 'node:test';
import assert from 'node:assert/strict';
import { McpHub } from '../src/mcp.ts';
import { startMcpHttpServer } from './mcp-http-fixture.js';

const local = { type: 'function', function: { name: 'local_tool', description: '', parameters: { type: 'object', properties: {} } } };

/** A port that was just in use and now has nothing listening. */
async function downServer() {
  const probe = await startMcpHttpServer();
  const { port } = new URL(probe.url);
  await probe.close();
  return { url: `http://127.0.0.1:${port}/mcp`, port: Number(port) };
}

async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('an unreachable server says why, and is tried again until it comes up', async (t) => {
  const down = await downServer();
  const hub = new McpHub({ remote: { url: down.url } });
  hub.retryDelay = { first: 20, max: 40 };
  await hub.connect();
  hub.registerLocal(local, () => 'ok');
  t.after(() => hub.close());

  assert.match(hub.errors.join(), /^remote: fetch failed \(.*ECONNREFUSED/);
  const [row] = hub.inventory().servers;
  assert.equal(row.status, 'error');
  assert.equal(row.retry.attempts, 1);
  assert.equal(typeof row.retry.nextAt, 'number');

  const fixture = await startMcpHttpServer({ port: down.port });
  t.after(() => fixture.close());
  // Connected and done: open() records the client before its tools are listed.
  await until(() => hub.clients.has('remote') && !hub.attaching.has('remote'));

  assert.deepEqual(hub.errors, []);
  const [up] = hub.inventory().servers;
  assert.equal(up.status, 'ok');
  assert.equal(up.retry, null);
  // In front of the built-ins, where it would have been had it been up from the start.
  assert.deepEqual(hub.tools.map((t) => t.function.name), ['remote__whoami', 'local_tool']);
  assert.equal(await hub.call('remote__whoami', {}, {}), 'identity=null');
});

test('retry() connects now, without waiting for the next attempt', async (t) => {
  const down = await downServer();
  const hub = new McpHub({ remote: { url: down.url } });
  hub.retryDelay = { first: 60_000, max: 60_000 };
  await hub.connect();
  t.after(() => hub.close());
  assert.equal(await hub.retry('remote'), false);
  assert.equal(hub.inventory().servers[0].retry.attempts, 2);

  const fixture = await startMcpHttpServer({ port: down.port });
  t.after(() => fixture.close());
  const [first, second] = await Promise.all([hub.retry('remote'), hub.retry('remote')]);
  assert.equal(first, true);
  assert.equal(second, true);
  assert.deepEqual(hub.tools.map((t) => t.function.name), ['remote__whoami']);
  // Already connected: nothing to do, and no second copy of its tools.
  assert.equal(await hub.retry('remote'), true);
  assert.equal(hub.tools.length, 1);
});

test('a server this hub starts itself is not retried on its own', async (t) => {
  const hub = new McpHub({ broken: { command: process.execPath, args: ['-e', 'process.exit(1)'] } });
  hub.retryDelay = { first: 10, max: 10 };
  await hub.connect();
  t.after(() => hub.close());
  const [row] = hub.inventory().servers;
  assert.equal(row.status, 'error');
  assert.equal(row.retry.attempts, 1);
  assert.equal(row.retry.nextAt, null);
});

test('closing the hub stops its retries', async () => {
  const down = await downServer();
  const hub = new McpHub({ remote: { url: down.url } });
  hub.retryDelay = { first: 20, max: 20 };
  await hub.connect();
  await hub.close();
  const fixture = await startMcpHttpServer({ port: down.port });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(hub.clients.has('remote'), false);
  assert.equal(await hub.retry('remote'), false);
  await fixture.close();
});
