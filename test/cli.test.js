// The scriptable CLI: what an agent runs to check, explain and change a
// deployment. Driven as a real subprocess, the way a script would.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configSchema } from '../src/cli.js';

const BIN = fileURLToPath(new URL('../bin/tinywebui.js', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'tinywebui-cli-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

writeFileSync(join(dir, 'tinywebui.config.js'), `export default { config: {
  authMode: 'trusted-header', trustedProxyCidrs: ['172.20.0.0/16'], apiKey: 'sk-very-secret',
  access: { bootstrapAdmins: ['root'], roles: { user: { features: ['chat'], models: ['a'] } } }
} };`);
writeFileSync(join(dir, 'tinywebui.config.json'), '{ "systemPrompt": "hi" }\n');
writeFileSync(join(dir, 'mcp.json'), '{ "mcpServers": { "s": { "url": "http://x", "headers": { "Authorization": "Bearer tok" } } } }\n');

const run = (...args) => {
  const env = { ...process.env };
  delete env.TINYWEBUI_CONFIG; delete env.TINYWEBUI_MCP;
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: dir, env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

test('validate passes a good setup and prints its fingerprint', () => {
  const r = run('validate');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^ok [0-9a-f]{16}\n$/);
  assert.equal(run('fingerprint').out.trim(), r.out.trim().slice(3));
});

test('effective output is clean JSON with no secret values', () => {
  const r = run('effective');
  const data = JSON.parse(r.out);
  assert.equal(data.settings.apiKey.value, '<set>');
  assert.equal(data.settings.authMode.change, 'file-only');
  assert.equal(data.settings.systemPrompt.change, 'editable');
  assert.deepEqual(data.roles.user, { features: ['chat'], models: ['a'] });
  assert.equal(data.mcpServers.servers.s.headers.Authorization, '<redacted>');
  assert.ok(!r.out.includes('sk-very-secret') && !r.out.includes('Bearer tok'));
  assert.deepEqual(JSON.parse(run('effective', '--role', 'user').out).features, ['chat']);
});

test('users set records decisions in config.json; code-declared users are refused', () => {
  assert.equal(run('users', 'set', 'alice', '--status', 'disabled').code, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'tinywebui.config.json'), 'utf8')).access.users.alice, { status: 'disabled' });
  const listed = JSON.parse(run('users', 'list').out);
  assert.deepEqual(listed.find((u) => u.externalId === 'alice').pinned, { status: 'disabled' });
  assert.equal(run('users', 'set', 'root', '--role', 'user').code, 1);
  assert.equal(run('users', 'set', 'alice', '--status', 'asleep').code, 1);
  assert.equal(run('users', 'set', 'alice', '--clear').code, 0);
  assert.equal(JSON.parse(readFileSync(join(dir, 'tinywebui.config.json'), 'utf8')).access.users.alice, undefined);
});

test('validate names problems and exits 1, including ones code shadows', () => {
  writeFileSync(join(dir, 'tinywebui.config.json'), '{ "access": { "roles": { "user": { "features": ["fly"] } } } }');
  const r = run('validate');
  assert.equal(r.code, 1);
  assert.match(r.err, /config\.json: .*unknown feature "fly"/);
  writeFileSync(join(dir, 'mcp.json'), '{ broken');
  assert.match(run('validate').err, /mcp\.json/);
});

test('validate never writes a generated secret', () => {
  writeFileSync(join(dir, 'tinywebui.config.json'), '{}');
  run('validate');
  assert.equal(readFileSync(join(dir, 'tinywebui.config.json'), 'utf8'), '{}');
});

test('the checked-in schema matches the code', () => {
  const onDisk = JSON.parse(readFileSync(new URL('../docs/config.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(onDisk, configSchema(), 'run: node bin/tinywebui.js schema > docs/config.schema.json');
});

test('migrate creates, then reports up to date; --check flags an old database', async () => {
  const d = mkdtempSync(join(tmpdir(), 'tinywebui-migrate-'));
  writeFileSync(join(d, 'tinywebui.config.json'), JSON.stringify({ dbPath: join(d, 'x.db'), autoMigrate: false }));
  const go = (...args) => spawnSync(process.execPath, [BIN, ...args, '--config', join(d, 'tinywebui.config.json')], { encoding: 'utf8' });
  assert.match(go('migrate').stdout, /created .* at schema \d+/);
  assert.match(go('migrate').stdout, /up to date/);
  // Roll the file back to schema 0: --check fails and a start refuses it.
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(d, 'x.db')); db.exec('PRAGMA user_version = 0'); db.close();
  const check = go('migrate', '--check');
  assert.equal(check.status, 1);
  assert.match(check.stderr, /run `tinywebui migrate`/);
  const { start } = await import('../src/server.js');
  await assert.rejects(start({ port: 0, configFile: join(d, 'tinywebui.config.json'), mcpServers: {} }), /tinywebui migrate/);
  assert.match(go('migrate').stdout, /migrated .* from schema 0/);
  assert.equal(go('migrate', '--check').status, 0);
  rmSync(d, { recursive: true, force: true });
});

test('doctor reports each check as a JSON line and fails on an unreachable model', () => {
  const d = mkdtempSync(join(tmpdir(), 'tinywebui-doctor-'));
  writeFileSync(join(d, 'tinywebui.config.json'), JSON.stringify({ dbPath: ':memory:', baseUrl: 'http://127.0.0.1:9/v1' }));
  writeFileSync(join(d, 'mcp.json'), '{ "mcpServers": {} }');
  const r = spawnSync(process.execPath, [BIN, 'doctor', '--config', join(d, 'tinywebui.config.json')], { encoding: 'utf8' });
  const lines = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.check), ['node', 'config', 'database', 'model endpoint', 'retrieval']);
  assert.equal(lines.find((l) => l.check === 'model endpoint').ok, false);
  assert.equal(r.status, 1);
  rmSync(d, { recursive: true, force: true });
});

test('config show is effective; unknown commands fail', () => {
  assert.deepEqual(JSON.parse(run('config', 'show', '--role', 'user').out).features, ['chat']);
  assert.equal(run('nonsense').code, 1);
});
