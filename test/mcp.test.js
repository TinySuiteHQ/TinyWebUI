// McpHub.activeTools / inventory, exercised without spawning any real MCP
// server: the hub's internal maps are populated by hand, the way connect()
// would have left them.
import test from 'node:test';
import assert from 'node:assert/strict';

import { McpHub } from '../src/mcp.js';

function fn(name, description = '') {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties: {} } } };
}

/** A hub as connect() would have left it, without touching a network or a process. */
function fixture() {
  const hub = new McpHub({
    alpha: { command: 'x' },
    beta: { command: 'x' },
    gamma: { command: 'x', disabled: true }
  });
  hub.clients.set('alpha', {}); // "connected"
  // beta never got a client: connect() failed on it
  hub.errors.push('beta: spawn ENOENT');

  hub.routes.set('alpha__search', { server: 'alpha', tool: 'search' });
  hub.routes.set('alpha__fetch', { server: 'alpha', tool: 'fetch' });
  hub.tools.push(fn('alpha__search', 'search the web'), fn('alpha__fetch', 'fetch a url'));

  hub.registerLocal(fn('context_expand', 'read compacted output'), async () => 'ok');
  return hub;
}

test('activeTools passes everything through when nothing is disabled', () => {
  const hub = fixture();
  assert.deepEqual(hub.activeTools([]), hub.tools);
  assert.deepEqual(hub.activeTools(), hub.tools);
});

test('activeTools drops exactly the named tools, built-in or MCP', () => {
  const hub = fixture();
  const active = hub.activeTools(['alpha__fetch', 'context_expand']);
  assert.deepEqual(active.map((t) => t.function.name), ['alpha__search']);
});

test('inventory separates built-ins from MCP tools grouped by server', () => {
  const hub = fixture();
  const inv = hub.inventory([]);

  assert.deepEqual(inv.internal.map((t) => t.name), ['context_expand']);
  assert.equal(inv.internal[0].disabled, false);

  const byName = Object.fromEntries(inv.servers.map((s) => [s.name, s]));
  assert.deepEqual(Object.keys(byName), ['alpha', 'beta', 'gamma'], 'every configured server appears, connected or not');

  assert.equal(byName.alpha.status, 'ok');
  assert.deepEqual(byName.alpha.tools.map((t) => t.name), ['alpha__search', 'alpha__fetch']);

  assert.equal(byName.beta.status, 'error');
  assert.equal(byName.beta.error, 'spawn ENOENT', 'the server-name prefix is stripped back off');
  assert.deepEqual(byName.beta.tools, []);

  assert.equal(byName.gamma.status, 'disabled');
  assert.equal(byName.gamma.error, null);
});

test('inventory marks disabled rows without changing what activeTools would send', () => {
  const hub = fixture();
  const inv = hub.inventory(['alpha__search']);
  const row = inv.servers.find((s) => s.name === 'alpha').tools.find((t) => t.name === 'alpha__search');
  assert.equal(row.disabled, true);
  // The flag is advisory; the tool is still IN the inventory and still in
  // hub.tools -- only activeTools() actually removes it from what is offered.
  assert.ok(hub.tools.some((t) => t.function.name === 'alpha__search'));
  assert.ok(!hub.activeTools(['alpha__search']).some((t) => t.function.name === 'alpha__search'));
});
