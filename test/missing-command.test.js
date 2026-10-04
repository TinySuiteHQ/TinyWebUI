// A stdio server whose command is not installed: named plainly, with the fix
// when there is a known one (uv for the TinySuite servers), instead of the
// SDK's "Connection closed".
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { McpHub, missingCommand } from '../src/mcp.js';

// A PATH with nothing on it, so every bare command is missing.
const emptyPath = { PATH: mkdtempSync(join(tmpdir(), 'twui-empty-path-')) };

test('a command on PATH is found', () => {
  assert.equal(missingCommand({ command: process.execPath }), null);
  assert.equal(missingCommand({ command: 'node' }), null);
});

test('missing uvx points at uv', () => {
  const m = missingCommand({ command: 'uvx', env: emptyPath });
  assert.deepEqual(m.install, { name: 'uv', url: 'https://docs.astral.sh/uv/' });
  assert.match(m.message, /"uvx" was not found/);
  assert.match(m.message, /https:\/\/docs\.astral\.sh\/uv\//);
});

test('any other missing command is named, with no install link', () => {
  const m = missingCommand({ command: 'no-such-mcp-server', env: emptyPath });
  assert.equal(m.install, null);
  assert.equal(m.message, '"no-such-mcp-server" was not found on PATH');
});

test('the hub reports it without spawning, and the inventory carries the fix', async () => {
  const hub = await new McpHub({
    tinysearch: { command: 'uvx', args: ['tinysearch'], env: emptyPath },
    other: { command: 'no-such-mcp-server', env: emptyPath }
  }).connect();
  try {
    const rows = Object.fromEntries(hub.inventory().servers.map((s) => [s.name, s]));
    assert.equal(rows.tinysearch.status, 'error');
    assert.match(rows.tinysearch.error, /uv/);
    assert.deepEqual(rows.tinysearch.install, { name: 'uv', url: 'https://docs.astral.sh/uv/' });
    assert.equal(rows.other.status, 'error');
    assert.equal(rows.other.install, null);
    assert.equal(hub.clients.size, 0);
  } finally {
    await hub.close();
  }
});

test('a server that dies while connecting has its stderr logged', () => {
  // In a child process: the hub logs through console.log, which the test
  // runner's own stdout protocol would not survive being mocked.
  const mcp = pathToFileURL(join(import.meta.dirname, '../src/mcp.js')).href;
  const script = `
    import { McpHub } from ${JSON.stringify(mcp)};
    const crash = 'console.error("invalid peer certificate"); process.exit(1)';
    const hub = await new McpHub({ broken: { command: process.execPath, args: ['-e', crash] } }).connect();
    await hub.close();
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(out, /broken: invalid peer certificate/);
});
