// A new install, with no mcp.json yet, starts with the TinySuite servers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createConfigSource } from '../src/config/config.ts';
import { serversIdentityProblems } from '../src/access/mcp_identity.ts';
import { serveProblems } from '../src/mcp_serve.ts';

const fresh = () => mkdtempSync(join(tmpdir(), 'twui-default-mcp-'));
const valid = (servers) => [...serversIdentityProblems(servers), ...Object.entries(servers).flatMap(([n, s]) => serveProblems(n, s))];

test('no mcp.json, with sign-in: TinySearch and TinyContext served per person by uvx', () => {
  const source = createConfigSource({ configFile: join(fresh(), 'tinywebui.config.json') });
  const servers = source.loadMcpServers();
  assert.deepEqual(Object.keys(servers).sort(), ['tinycontext', 'tinysearch']);
  const { tinysearch, tinycontext } = servers;
  assert.equal(tinysearch.command, 'uvx');
  assert.ok(tinysearch.args.includes('tinysuite-search[server]>=0.6.8'), 'the first release with the proxy token');
  assert.equal(tinycontext.command, 'uvx');
  assert.ok(tinycontext.args.includes('tinysuite-context[server]>=0.5.4'));
  assert.deepEqual(valid(servers), []);
  // Each in its own multi-user mode, every call proven with a proxy token.
  assert.deepEqual(tinycontext.identity, { header: 'X-TinyContext-User-Id' });
  assert.equal(tinycontext.env.TINYCONTEXT_TENANCY, 'proxy-header');
  assert.equal(tinycontext.env.TINYCONTEXT_TRUSTED_PROXY_CIDRS, '127.0.0.1/32');
  assert.deepEqual(tinycontext.serve.secrets, ['TINYCONTEXT_TENANT_SECRET']);
  assert.equal(tinycontext.serve.proxyToken.env, 'TINYCONTEXT_TRUSTED_PROXY_TOKEN');
  assert.deepEqual(tinysearch.identity, { header: 'X-TinySearch-User-Id' });
  assert.equal(tinysearch.serve.proxyToken.header, 'X-TinySearch-Proxy-Token');
  // Recording what was searched stays opt-in.
  assert.equal(tinysearch.env.TINYSEARCH_ACTIVITY, undefined);
  // No secret is written into mcp.json: tokens are made per launch, the tenant secret is stored.
  assert.ok(!/[0-9a-f]{32}/.test(JSON.stringify(servers)));
  // The MCP panel shows the same servers, so saving it keeps them.
  assert.deepEqual(JSON.parse(source.readMcpFile()).mcpServers, servers);
});

test('their data, models and config live under TinyWebUI\'s own folder', () => {
  for (const authMode of ['multiuser', 'local']) {
    const source = createConfigSource({ configFile: join(fresh(), 'tinywebui.config.json'), config: { authMode } });
    const { tinysearch, tinycontext } = source.loadMcpServers();
    const paths = Object.entries({ ...tinysearch.env, ...tinycontext.env }).filter(([k]) => /_(DIR|PATH|DB)$/.test(k));
    assert.ok(paths.length >= 6, authMode);
    for (const [key, value] of paths) assert.match(value, /^\$\{TINYWEBUI_DATA_DIR\}\/mcp\/tiny(search|context)\//, `${authMode} ${key}`);
  }
});

test('no mcp.json, no sign-in: one person, so plain stdio', () => {
  const source = createConfigSource({ configFile: join(fresh(), 'tinywebui.config.json'), config: { authMode: 'local' } });
  const servers = source.loadMcpServers();
  for (const spec of Object.values(servers)) {
    assert.equal(spec.serve, undefined);
    assert.equal(spec.identity, undefined);
  }
  assert.equal(servers.tinysearch.env.TINYSEARCH_MANAGEMENT, 'on');
  assert.equal(servers.tinycontext.env.TINYCONTEXT_MANAGEMENT, 'on');
  assert.deepEqual(valid(servers), []);
});

test('a served server\'s secret is generated once and kept in the secrets file', () => {
  const dir = fresh();
  const source = createConfigSource({ configFile: join(dir, 'tinywebui.config.json') });
  assert.equal(source.dataDir(), dir);
  const first = source.mcpSecret('tinycontext', 'TINYCONTEXT_TENANT_SECRET');
  assert.match(first, /^[0-9a-f]{64}$/);
  const again = createConfigSource({ configFile: join(dir, 'tinywebui.config.json') });
  assert.equal(again.mcpSecret('tinycontext', 'TINYCONTEXT_TENANT_SECRET'), first, 'stable across restarts');
  assert.notEqual(again.mcpSecret('other', 'TINYCONTEXT_TENANT_SECRET'), first, 'one per server');
  const stored = JSON.parse(readFileSync(again.secretsPath(), 'utf8'));
  assert.equal(stored.mcp.tinycontext.TINYCONTEXT_TENANT_SECRET, first);
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
