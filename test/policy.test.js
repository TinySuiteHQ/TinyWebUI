// The access policy: validation, resolution, key classes and fingerprints.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateConfig, featuresFor, modelsFor, customizeFor, roleNames, isRole, resolveAccess, fingerprint, keyClass, mergeAccess
} from '../server/access/policy.ts';
import { createConfigSource, LockedError } from '../server/config/config.ts';

const tier3 = (access) => ({ authMode: 'trusted-header', trustedProxyCidrs: ['10.0.0.0/8'], access });

test('valid configs have no errors', () => {
  assert.deepEqual(validateConfig({ authMode: 'local' }), []);
  assert.deepEqual(validateConfig(tier3({ roles: { user: { features: ['chat'], models: ['a'] } }, bootstrapAdmins: ['x'] })), []);
});

test('every mistake is named', () => {
  const errs = validateConfig({
    authMode: 'trusted-header',
    access: {
      nonsense: 1, newUsers: 'maybe', bootstrapAdmins: 'me',
      roles: { user: { features: ['chat', 'teleport'], models: 7, colour: 'x', customize: ['wallpaper'] }, 'Big Boss': {} },
      users: { a: { role: 'god', status: 'asleep' } }
    }
  }).join('\n');
  for (const needle of ['trustedProxyCidrs', 'access.nonsense', 'newUsers', 'bootstrapAdmins', 'teleport', 'models must be', 'colour', 'wallpaper', 'a role name is', 'role must be', 'status must be']) {
    assert.match(errs, new RegExp(needle), needle);
  }
  assert.match(validateConfig({ authMode: 'single' }, { env: {} }).join(), /no longer supported/);
  assert.match(validateConfig({ authMode: 'local', authPassword: 'legacy hash' }, { env: {} }).join(), /cannot use authPassword/);
  assert.match(validateConfig({ authMode: 'local' }, { env: { TINYWEBUI_PASSWORD: 'legacy password' } }).join(), /no longer selects password login/);
  assert.deepEqual(validateConfig({ authMode: 'local' }, { env: {} }), []);
  assert.deepEqual(validateConfig({ authMode: 'multiuser' }), []);
});

test('features and models resolve per role, with sensible defaults', () => {
  const cfg = tier3({ roles: { user: { features: ['chat', 'attachments'], models: ['m1'] } } });
  assert.deepEqual([...featuresFor(cfg, 'user')].sort(), ['attachments', 'chat']);
  assert.ok(featuresFor(cfg, 'admin').has('oversight'));
  assert.deepEqual(modelsFor(cfg, 'user'), ['m1']);
  assert.equal(modelsFor(cfg, 'admin'), '*');
  assert.ok(!featuresFor(tier3(), 'user').has('settings'), 'users get no settings by default');
  const solo = featuresFor({ authMode: 'local' }, null);
  assert.ok(solo.has('settings') && solo.has('mcp') && !solo.has('admin'));
});

test('custom roles sit beside the built-ins, start with nothing, and say what they may personalise', () => {
  const cfg = tier3({
    customize: ['theme', 'instructions'],
    roles: { reviewer: { features: ['chat', 'oversight'], models: ['m2'], customize: [] }, empty: {} },
    users: { a: { role: 'reviewer' } }
  });
  assert.deepEqual(validateConfig(cfg), []);
  assert.deepEqual(roleNames(cfg), ['admin', 'user', 'reviewer', 'empty']);
  assert.deepEqual([...featuresFor(cfg, 'reviewer')].sort(), ['chat', 'oversight']);
  assert.deepEqual(modelsFor(cfg, 'reviewer'), ['m2']);
  assert.deepEqual(customizeFor(cfg, 'reviewer'), []);
  assert.deepEqual(customizeFor(cfg, 'user'), ['theme', 'instructions'], 'a role that does not say takes access.customize');
  assert.equal(featuresFor(cfg, 'empty').size, 0);
  // A role the files no longer define (or never did) grants nothing.
  for (const gone of ['editor', 'constructor', '__proto__']) {
    assert.equal(featuresFor(cfg, gone).size, 0, gone);
    assert.deepEqual(modelsFor(cfg, gone), [], gone);
    assert.equal(isRole(cfg, gone), false, gone);
  }
  assert.equal(resolveAccess(tier3()).newUsers, 'pending', 'new people wait for an admin unless the files say otherwise');
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
  writeFileSync(file, '{"authMode":"local"}');
  const source = createConfigSource({ configFile: file, config: { model: 'frozen-model' } });
  assert.throws(() => source.save({ authMode: 'local' }), LockedError);
  assert.throws(() => source.save({ access: { roles: {} } }), LockedError);
  assert.throws(() => source.save({ model: 'x' }), LockedError, 'frozen by code');
  source.save({ systemPrompt: 'hello' });
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).systemPrompt, 'hello', 'editable keys land in the file');
  const locked = source.lockedKeys();
  assert.equal(keyClass('authMode', locked), 'file-only');
  assert.equal(keyClass('model', locked), 'frozen');
  assert.equal(keyClass('systemPrompt', locked), 'editable');
});
