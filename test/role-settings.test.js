// Settings per role: what a role sets for its people (prompt, default model,
// sampling, approval) wins over the global value and a model's own; a blank
// inherits; a person's own model pick still beats the role's default.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateConfig, roleSettingsFor } from '../server/access/policy.ts';
import { effectiveConfig } from '../server/config/models.ts';
import { approvalFor } from '../server/config/approval.ts';
import { DEFAULTS } from '../server/config/config.ts';
import { trustedServer } from './trusted-helpers.js';

const multi = (roles) => ({ authMode: 'trusted-header', trustedProxyCidrs: ['127.0.0.1/32'], access: { roles } });

test('a role\'s settings are checked: known keys, types, ranges, and a model the role may use', () => {
  assert.deepEqual(validateConfig(multi({ student: { models: ['a'], settings: { systemPrompt: 'S', model: 'a', temperature: 0.3, toolApproval: 'all' } } })), []);
  const problems = (settings, models) => validateConfig(multi({ student: { ...(models ? { models } : {}), settings } })).join('\n');
  assert.match(problems({ colour: 'blue' }), /settings\.colour is not a known setting/);
  assert.match(problems({ temperature: 3 }), /temperature must be a number from 0 to 2/);
  assert.match(problems({ maxToolRounds: 2.5 }), /maxToolRounds must be a whole number/);
  assert.match(problems({ askUserTimeoutSeconds: -1 }), /askUserTimeoutSeconds/);
  assert.match(problems({ toolApproval: 'sometimes' }), /toolApproval must be one of writes, all, off/);
  assert.match(problems({ systemPrompt: 7 }), /systemPrompt must be text/);
  assert.match(problems({ model: 'b' }, ['a']), /model "b" is not one of this role's models/);
  assert.equal(problems({ model: 'b' }), '', 'a role with any model may start on any');
  assert.match(problems('everything'), /settings must be an object/);
});

test("a role's per-model settings are checked: a model the role may use, and only the keys that are about a turn", () => {
  const problems = (modelSettings, models) => validateConfig(multi({ student: { ...(models ? { models } : {}), modelSettings } })).join('\n');
  assert.equal(problems({ a: { systemPrompt: 'A', temperature: 0.5, maxTokens: 100, maxToolRounds: 4, toolApproval: 'all' } }, ['a']), '');
  assert.match(problems({ b: { temperature: 0.5 } }, ['a']), /modelSettings: "b" is not one of this role's models/);
  assert.match(problems({ a: { model: 'a' } }), /modelSettings\.a\.model is not a known setting/);
  assert.match(problems({ a: { askUserTimeoutSeconds: 5 } }), /askUserTimeoutSeconds is not a known setting/);
  assert.match(problems({ a: { temperature: 5 } }), /modelSettings\.a\.temperature must be a number from 0 to 2/);
  assert.match(problems({ a: 'hot' }), /modelSettings\.a must be an object/);
  assert.match(problems(['a']), /modelSettings must be an object/);
});

test("a role's settings for one model win over its settings for all of them, on that model only", () => {
  const cfg = multi({ user: { settings: { systemPrompt: 'ROLE', temperature: 0.2 }, modelSettings: { smart: { temperature: 0.9 } } } });
  assert.deepEqual(roleSettingsFor(cfg, 'user', 'smart'), { systemPrompt: 'ROLE', temperature: 0.9 });
  assert.deepEqual(roleSettingsFor(cfg, 'user', 'fast'), { systemPrompt: 'ROLE', temperature: 0.2 });
  assert.deepEqual(roleSettingsFor(cfg, 'user'), { systemPrompt: 'ROLE', temperature: 0.2 });
  assert.deepEqual(roleSettingsFor(cfg, 'user', 'constructor'), { systemPrompt: 'ROLE', temperature: 0.2 }, 'no prototype lookups');
  assert.deepEqual(roleSettingsFor(multi({ user: { modelSettings: { smart: { maxTokens: 5 } } } }), 'user', 'smart'), { maxTokens: 5 });
});

test('roles only exist with accounts: tiers 1-2 and unknown roles get no settings', () => {
  const roles = { user: { settings: { systemPrompt: 'S' } } };
  assert.deepEqual(roleSettingsFor({ authMode: 'local', access: { roles } }, 'user'), {});
  assert.deepEqual(roleSettingsFor(multi(roles), 'ghost'), {});
  assert.deepEqual(roleSettingsFor(multi(roles), 'user'), { systemPrompt: 'S' });
  assert.deepEqual(roleSettingsFor(multi({}), 'user'), {});
});

test('in a turn, the role wins over the model entry and the global value; the endpoint is untouched', () => {
  const cfg = {
    ...DEFAULTS, model: 'fast', systemPrompt: 'GLOBAL', temperature: 0.7, maxToolRounds: 12, toolApproval: 'writes',
    extraBody: { provider: { zdr: true } },
    connectors: [{ id: 'c', baseUrl: 'http://conn/v1', apiKey: 'ck' }],
    models: [{ id: 'fast', connector: 'c', systemPrompt: 'MODEL', temperature: 1, extraBody: { reasoning: { effort: 'low' } } }]
  };
  const plain = effectiveConfig(cfg, 'fast');
  assert.equal(plain.systemPrompt, 'MODEL');
  const role = effectiveConfig(cfg, 'fast', { systemPrompt: 'ROLE', temperature: 0.2, maxToolRounds: 3, toolApproval: 'all' });
  assert.equal(role.systemPrompt, 'ROLE');
  assert.equal(role.temperature, 0.2);
  assert.equal(role.maxToolRounds, 3);
  assert.equal(role.baseUrl, 'http://conn/v1');
  assert.equal(role.apiKey, 'ck');
  assert.deepEqual(role.extraBody, { provider: { zdr: true }, reasoning: { effort: 'low' } });
  assert.equal(effectiveConfig(cfg, 'fast', { temperature: 0.2 }).systemPrompt, 'MODEL', 'what the role leaves out inherits');
  // The approval mode travels in the turn's config, which is what the tool executor asks.
  const hub = { isReadOnly: () => false };
  assert.equal(approvalFor({ ...cfg, toolApproval: 'off' }, hub, 'srv__write'), 'auto');
  assert.equal(approvalFor(effectiveConfig({ ...cfg, toolApproval: 'off' }, 'fast', { toolApproval: 'all' }), hub, 'srv__write'), 'ask');
});

/* ---------- a live server: what the provider is actually sent ---------- */

const seen = [];
const fake = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    if (req.url.endsWith('/models')) { res.writeHead(404); return res.end(); }
    const b = JSON.parse(body);
    seen.push({ model: b.model, system: b.messages.find((m) => m.role === 'system')?.content || '', temperature: b.temperature });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
});
const port = await new Promise((r) => fake.listen(0, '127.0.0.1', () => r(fake.address().port)));
test.after(() => fake.close());

test('a role\'s prompt replaces the system prompt, its default model applies, and the person\'s own instructions still follow', async (t) => {
  const { srv, as } = await trustedServer({
    baseUrl: `http://127.0.0.1:${port}/v1`, model: 'fast', systemPrompt: 'GLOBAL', temperature: 0.7,
    models: [{ id: 'fast' }, { id: 'smart' }],
    access: {
      customize: ['instructions'],
      roles: {
        user: { features: ['chat', 'model-picker'], models: '*' },
        student: {
          features: ['chat', 'model-picker'], models: ['fast', 'smart'], settings: { systemPrompt: 'STUDENT', model: 'smart', temperature: 0.2 },
          modelSettings: { fast: { systemPrompt: 'STUDENT ON FAST', temperature: 0.9 } }
        }
      },
      users: { 'sub-stu': { role: 'student' }, 'sub-stu2': { role: 'student' } }
    }
  });
  t.after(() => srv.shutdown());
  const chat = async (who) => {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-tinysuite-user-id': who }, body: JSON.stringify({ message: 'hi' })
    });
    await res.text();
  };

  assert.equal((await as({ id: 'sub-stu' })('/api/auth/me')).data.model, 'smart', 'the role\'s default');
  assert.equal((await as({ id: 'sub-plain' })('/api/auth/me')).data.model, 'fast', 'everyone else keeps the global default');

  await as({ id: 'sub-stu' })('/api/me/prefs', { method: 'POST', body: { instructions: 'Be terse.' } });
  await chat('sub-stu');
  await chat('sub-plain');
  const [stu, plain] = seen.slice(-2);
  assert.equal(stu.model, 'smart');
  assert.equal(stu.temperature, 0.2);
  assert.match(stu.system, /STUDENT[\s\S]*Be terse\./);
  assert.ok(!stu.system.includes('GLOBAL'), 'replaced, not added to');
  assert.equal(plain.model, 'fast');
  assert.equal(plain.temperature, 0.7);
  assert.match(plain.system, /GLOBAL/);

  // Their own pick still beats the role's default.
  assert.equal((await as({ id: 'sub-stu2' })('/api/me/prefs', { method: 'POST', body: { model: 'fast' } })).data.model, 'fast');
  await chat('sub-stu2');
  assert.equal(seen.at(-1).model, 'fast');
  // On that model the role's own settings for it apply.
  assert.equal(seen.at(-1).temperature, 0.9);
  assert.match(seen.at(-1).system, /STUDENT ON FAST/);
});

test('an admin sets a role\'s settings, blanks drop out, the admin role takes settings only, and a bad value writes nothing', async (t) => {
  const d = mkdtempSync(join(tmpdir(), 'tinywebui-rolesettings-'));
  const file = join(d, 'tinywebui.config.json');
  writeFileSync(file, JSON.stringify({ models: [{ id: 'a' }, { id: 'b' }], model: 'a', access: { bootstrapAdmins: ['sub-root'], newUsers: 'approved' } }));
  writeFileSync(join(d, 'mcp.json'), '{ "mcpServers": {} }\n');
  const { start } = await import('../server/server.ts');
  const s = await start({
    port: 0, host: '127.0.0.1', configFile: file, dbPath: join(d, 'p.db'),
    config: { authMode: 'trusted-header', trustedProxyCidrs: ['127.0.0.1/32'], baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k' }
  });
  t.after(() => s.shutdown());
  const root = async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(`http://127.0.0.1:${s.address().port}${path}`, {
      method, headers: { 'content-type': 'application/json', 'x-tinysuite-user-id': 'sub-root' }, body: body && JSON.stringify(body)
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  const saved = () => JSON.parse(readFileSync(file, 'utf8')).access;

  const ok = await root('/api/admin/roles/user', { method: 'PATCH', body: { settings: { systemPrompt: 'Help students.', model: 'b', temperature: 0.4, maxTokens: null, toolApproval: '' } } });
  assert.equal(ok.status, 200);
  assert.deepEqual(saved().roles.user.settings, { systemPrompt: 'Help students.', model: 'b', temperature: 0.4 });
  assert.deepEqual(ok.data.roles.find((r) => r.name === 'user').settings, { systemPrompt: 'Help students.', model: 'b', temperature: 0.4 });

  const bad = await root('/api/admin/roles/user', { method: 'PATCH', body: { settings: { temperature: 9 } } });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /temperature/);
  assert.equal(saved().roles.user.settings.temperature, 0.4, 'nothing written');
  assert.equal((await root('/api/admin/roles/user', { method: 'PATCH', body: { settings: { model: 'zzz' } } })).status, 400, 'a model outside the catalog');

  assert.equal((await root('/api/admin/roles/admin', { method: 'PATCH', body: { settings: { systemPrompt: 'Admin mode.' } } })).status, 200);
  assert.deepEqual(saved().roles.admin, { settings: { systemPrompt: 'Admin mode.' } });
  assert.equal((await root('/api/admin/roles/admin', { method: 'PATCH', body: { features: ['chat'], settings: {} } })).status, 400, 'admins keep everything');

  // Per model: blanks drop out, a model with nothing left goes, a model outside the role is refused.
  const pm = await root('/api/admin/roles/user', { method: 'PATCH', body: { modelSettings: { a: { temperature: 0.8, maxTokens: null }, b: { systemPrompt: '' } } } });
  assert.equal(pm.status, 200);
  assert.deepEqual(saved().roles.user.modelSettings, { a: { temperature: 0.8 } });
  assert.deepEqual(pm.data.roles.find((r) => r.name === 'user').modelSettings, { a: { temperature: 0.8 } });
  assert.equal(saved().roles.user.settings.temperature, 0.4, "the role's own settings are untouched");
  assert.equal((await root('/api/admin/roles/user', { method: 'PATCH', body: { modelSettings: { zzz: { temperature: 1 } } } })).status, 400, 'a model outside the catalog');
  assert.equal((await root('/api/admin/roles/user', { method: 'PATCH', body: { modelSettings: { a: 'hot' } } })).status, 400);
  assert.equal((await root('/api/admin/roles/admin', { method: 'PATCH', body: { modelSettings: { b: { toolApproval: 'all' } } } })).status, 200, 'the admin role takes them too');
  await root('/api/admin/roles/user', { method: 'PATCH', body: { modelSettings: { a: { temperature: null } } } });
  assert.equal(saved().roles.user.modelSettings, undefined, 'all blank: gone');

  // Every field blank: the role inherits everything again.
  await root('/api/admin/roles/user', { method: 'PATCH', body: { settings: { systemPrompt: '', model: '', temperature: null } } });
  assert.equal(saved().roles.user.settings, undefined);
});
