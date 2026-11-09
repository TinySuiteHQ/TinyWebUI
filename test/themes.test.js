// Themes: the admin's default for everyone, a person's own pick where their
// role allows it, and imported themes, private or (admin) for everyone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { themeCssProblem, THEME_CSS_LIMIT } from '../server/routes/themes.ts';

const TEMPLATE = readFileSync(new URL('../web/public/themes/template.css', import.meta.url), 'utf8');
const css = (body = '--bg: #000;') => `:root[data-theme="custom"] { ${body} }`;

test('an imported theme is only variables and rules: nothing loaded from elsewhere', () => {
  assert.equal(themeCssProblem(TEMPLATE), null, 'the template imports as is');
  assert.equal(themeCssProblem(css('background: url("data:image/png;base64,AA==");')), null);
  assert.equal(themeCssProblem(`/* url(https://x) @import */ ${css()}`), null, 'comments are not rules');
  assert.match(themeCssProblem(`@import "https://x/y.css"; ${css()}`), /@import/);
  assert.match(themeCssProblem(css('background: url(https://evil.example/p.png);')), /elsewhere/);
  assert.match(themeCssProblem(css('background: url( /api/x );')), /elsewhere/);
  assert.match(themeCssProblem(':root { --bg: #000; }'), /template/);
  assert.match(themeCssProblem(css(`--x: "${'a'.repeat(THEME_CSS_LIMIT)}";`)), /at most/);
  assert.match(themeCssProblem(''), /empty/);
});

test('the template names every colour the default look sets', () => {
  const styles = readFileSync(new URL('../web/src/styles/base.css', import.meta.url), 'utf8');
  // The last top-level :root block is the palette in use (each one overrides the one before).
  const blocks = [...styles.matchAll(/^:root \{([^}]*)\}/gm)];
  const palette = new Set([...blocks.at(-1)[1].matchAll(/(--[\w-]+):/g)].map((m) => m[1]));
  const named = new Set([...TEMPLATE.matchAll(/(--[\w-]+):/g)].map((m) => m[1]));
  for (const v of palette) assert.ok(named.has(v), `template.css is missing ${v}`);
});

const dir = mkdtempSync(join(tmpdir(), 'tinywebui-themes-'));
const configFile = join(dir, 'tinywebui.config.json');
writeFileSync(configFile, JSON.stringify({
  access: {
    bootstrapAdmins: ['sub-root'], newUsers: 'approved',
    roles: { user: { customize: ['theme'] }, viewer: { features: ['chat'], customize: [] } },
    users: { 'sub-viewer': { role: 'viewer' } }
  }
}));
writeFileSync(join(dir, 'mcp.json'), '{ "mcpServers": {} }\n');
const { start } = await import('../server/server.ts');
const srv = await start({
  port: 0, host: '127.0.0.1', configFile, dbPath: join(dir, 't.db'),
  config: { authMode: 'trusted-header', trustedProxyCidrs: ['127.0.0.1/32'], baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'm' }
});
test.after(() => srv.shutdown());
const as = (id) => async (path, { method = 'GET', body } = {}) => {
  const res = await fetch(`http://127.0.0.1:${srv.address().port}${path}`, {
    method, headers: { 'content-type': 'application/json', 'x-tinysuite-user-id': id }, body: body && JSON.stringify(body)
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* CSS */ }
  return { status: res.status, data, text, type: res.headers.get('content-type') };
};
const root = as('sub-root');
const alice = as('sub-alice');
const bob = as('sub-bob');
const viewer = as('sub-viewer');
const savedTheme = () => JSON.parse(readFileSync(configFile, 'utf8')).theme;

test('a personal theme is its owner\'s alone', async () => {
  const made = await alice('/api/themes', { method: 'POST', body: { name: 'Dusk', css: css('--bg: #123;') } });
  assert.equal(made.status, 201);
  assert.equal(made.data.shared, false);
  assert.deepEqual((await alice('/api/themes')).data.custom.map((t) => t.name), ['Dusk']);
  const file = await alice(`/api/themes/${made.data.id}.css`);
  assert.equal(file.status, 200);
  assert.match(file.type, /^text\/css/);
  assert.match(file.text, /--bg: #123/);

  assert.deepEqual((await bob('/api/themes')).data.custom, []);
  assert.equal((await bob(`/api/themes/${made.data.id}.css`)).status, 404);
  assert.equal((await bob(`/api/themes/${made.data.id}`, { method: 'DELETE' })).status, 404);
  assert.equal((await bob('/api/me/theme', { method: 'POST', body: { theme: made.data.id } })).status, 400, 'nor can anyone else pick it');

  assert.equal((await alice('/api/me/theme', { method: 'POST', body: { theme: made.data.id } })).status, 200);
  assert.equal((await alice('/api/themes')).data.choice, made.data.id);
  assert.equal((await alice(`/api/themes/${made.data.id}`, { method: 'DELETE' })).status, 200);
  assert.deepEqual((await alice('/api/themes')).data.custom, []);
});

test('only an admin adds a theme for everyone or sets the default', async () => {
  assert.equal((await alice('/api/themes', { method: 'POST', body: { name: 'Org', css: css(), shared: true } })).status, 403);
  const org = await root('/api/themes', { method: 'POST', body: { name: 'Org', css: css(), shared: true } });
  assert.equal(org.status, 201);
  assert.deepEqual((await bob('/api/themes')).data.custom, [{ id: org.data.id, name: 'Org', shared: true }]);
  assert.equal((await bob(`/api/themes/${org.data.id}.css`)).status, 200);
  assert.equal((await bob(`/api/themes/${org.data.id}`, { method: 'DELETE' })).status, 403);

  assert.equal((await root('/api/config', { method: 'POST', body: { theme: org.data.id } })).status, 200);
  assert.equal(savedTheme(), org.data.id);
  assert.equal((await viewer('/api/themes')).data.default, org.data.id);

  // Gone, so nobody is left on a theme that does not exist.
  assert.equal((await root(`/api/themes/${org.data.id}`, { method: 'DELETE' })).status, 200);
  assert.equal(savedTheme(), '');
  assert.equal((await bob('/api/themes')).data.default, '');
});

test('a role without the theme permission gets the default and nothing to pick', async () => {
  const t = (await viewer('/api/themes')).data;
  assert.equal(t.canChoose, false);
  assert.equal(t.choice, null);
  assert.equal((await viewer('/api/me/theme', { method: 'POST', body: { theme: 'cyber-grid' } })).status, 403);
  assert.equal((await viewer('/api/themes', { method: 'POST', body: { name: 'Mine', css: css() } })).status, 403);
});

test('a pick is a built-in, plain, or back to the default', async () => {
  for (const theme of ['cyber-grid', '', null]) {
    const r = await bob('/api/me/theme', { method: 'POST', body: { theme } });
    assert.equal(r.status, 200, String(theme));
    assert.equal((await bob('/api/themes')).data.choice, theme);
  }
  assert.equal((await bob('/api/me/theme', { method: 'POST', body: { theme: 'no-such-theme' } })).status, 400);
  assert.equal((await bob('/api/me/theme', { method: 'POST', body: { theme: 42 } })).status, 400);
});

test('an import is checked before it is kept', async () => {
  assert.equal((await alice('/api/themes', { method: 'POST', body: { name: '', css: css() } })).status, 400);
  const bad = await alice('/api/themes', { method: 'POST', body: { name: 'X', css: `@import "https://x"; ${css()}` } });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /@import/);
  assert.deepEqual((await alice('/api/themes')).data.custom, []);
});
