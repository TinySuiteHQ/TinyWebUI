// The access policy: validation, resolution, key classes and fingerprints.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateConfig, featuresFor, modelsFor, fingerprint, keyClass, mergeAccess } from '../src/access/policy.js';
import { createConfigSource, LockedError } from '../src/config/config.js';

const tier3 = (access) => ({ authMode: 'trusted-header', trustedProxyCidrs: ['10.0.0.0/8'], access });

test('valid configs have no errors', () => {
  assert.deepEqual(validateConfig({ authMode: 'none' }), []);
  assert.deepEqual(validateConfig(tier3({ roles: { user: { features: ['chat'], models: ['a'] } }, bootstrapAdmins: ['x'] })), []);
});

test('every mistake is named', () => {
  const errs = validateConfig({
    authMode: 'trusted-header',
    access: {
      nonsense: 1, newUsers: 'maybe', bootstrapAdmins: 'me',
      roles: { user: { features: ['chat', 'teleport'], models: 7, colour: 'x' }, owner: {} },
      users: { a: { role: 'god', status: 'asleep' } }
    }
  }).join('\n');
  for (const needle of ['trustedProxyCidrs', 'access.nonsense', 'newUsers', 'bootstrapAdmins', 'teleport', 'models must be', 'colour', 'unknown role', 'role must be', 'status must be']) {
    assert.match(errs, new RegExp(needle), needle);
  }
  assert.match(validateConfig({ authMode: 'single', authPassword: 'plain' }).join(), /must be a hash/);
  assert.match(validateConfig({ authMode: 'single' }, { env: {} }).join(), /needs a password/);
  assert.match(validateConfig({ authMode: 'single' }, { env: { TINYWEBUI_PASSWORD: 'short' } }).join(), /at least 15 characters/);
  assert.deepEqual(validateConfig({ authMode: 'single' }, { env: { TINYWEBUI_PASSWORD: 'a long test password' } }), []);
  assert.match(validateConfig({ authMode: 'multiuser' }).join(), /trusted-header/);
});

test('features and models resolve per role, with sensible defaults', () => {
  const cfg = tier3({ roles: { user: { features: ['chat', 'attachments'], models: ['m1'] } } });
  assert.deepEqual([...featuresFor(cfg, 'user')].sort(), ['attachments', 'chat']);
  assert.ok(featuresFor(cfg, 'admin').has('oversight'));
  assert.deepEqual(modelsFor(cfg, 'user'), ['m1']);
  assert.equal(modelsFor(cfg, 'admin'), '*');
  assert.ok(!featuresFor(tier3(), 'user').has('settings'), 'users get no settings by default');
  const solo = featuresFor({ authMode: 'none' }, null);
  assert.ok(solo.has('settings') && solo.has('mcp') && !solo.has('admin'));
});

test('code wins over the file in access, per user too', () => {
  const m = mergeAccess(
    { newUsers: 'pending', users: { a: { status: 'disabled' }, b: { role: 'admin' } } },
    { newUsers: 'approved', users: { b: { role: 'user' } } }
  );
  assert.equal(m.newUsers, 'approved');
  assert.deepEqual(m.users, { a: { status: 'disabled' }, b: { role: 'user' } });
});

test('fingerprints ignore key order and never contain secret values', () => {
  const a = fingerprint({ model: 'x', apiKey: 'sk-1', systemPrompt: 'p' });
  const b = fingerprint({ systemPrompt: 'p', apiKey: 'sk-2', model: 'x' });
  assert.equal(a, b, 'a rotated secret does not change the fingerprint');
  assert.notEqual(a, fingerprint({ model: 'y', apiKey: 'sk-1', systemPrompt: 'p' }));
  assert.equal(a, fingerprint({ model: 'x', apiKey: 'other', systemPrompt: 'p' }));
  assert.notEqual(a, fingerprint({ model: 'x', apiKey: '', systemPrompt: 'p' }), 'presence still counts');
});

test('file-only keys are refused by save even when nothing locks them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tinywebui-policy-'));
  const file = join(dir, 'c.json');
  writeFileSync(file, '{"authMode":"none"}');
  const source = createConfigSource({ configFile: file, config: { model: 'frozen-model' } });
  assert.throws(() => source.save({ authMode: 'none' }), LockedError);
  assert.throws(() => source.save({ access: { roles: {} } }), LockedError);
  assert.throws(() => source.save({ model: 'x' }), LockedError, 'frozen by code');
  source.save({ systemPrompt: 'hello' });
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).systemPrompt, 'hello', 'editable keys land in the file');
  const locked = source.lockedKeys();
  assert.equal(keyClass('authMode', locked), 'file-only');
  assert.equal(keyClass('model', locked), 'frozen');
  assert.equal(keyClass('systemPrompt', locked), 'editable');
});
