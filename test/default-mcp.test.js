// A new install, with no mcp.json yet, starts with the TinySuite servers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createConfigSource } from '../src/config/config.js';

const fresh = () => mkdtempSync(join(tmpdir(), 'twui-default-mcp-'));

test('no mcp.json: TinySearch and TinyContext, launched by uvx', () => {
  const source = createConfigSource({ configFile: join(fresh(), 'tinywebui.config.json') });
  const servers = source.loadMcpServers();
  assert.deepEqual(Object.keys(servers).sort(), ['tinycontext', 'tinysearch']);
  assert.equal(servers.tinysearch.command, 'uvx');
  assert.ok(servers.tinysearch.args.includes('tinysuite-search[server]'));
  assert.equal(servers.tinycontext.command, 'uvx');
  assert.ok(servers.tinycontext.args.includes('tinysuite-context[server]'));
  // The MCP panel shows the same servers, so saving it keeps them.
  assert.deepEqual(JSON.parse(source.readMcpFile()).mcpServers, servers);
});

test('any mcp.json, even an empty one, replaces the defaults', () => {
  const dir = fresh();
  writeFileSync(join(dir, 'mcp.json'), '{ "mcpServers": {} }\n');
  const source = createConfigSource({ configFile: join(dir, 'tinywebui.config.json') });
  assert.deepEqual(source.loadMcpServers(), {});
});

test('servers set in code replace the defaults', () => {
  const source = createConfigSource({ configFile: false, mcpServers: {} });
  assert.deepEqual(source.loadMcpServers(), {});
});
