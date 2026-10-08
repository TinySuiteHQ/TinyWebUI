// Hybrid search is the default ('auto'), but an install without the model or
// the onnx packages still starts, lexical, and says why. An explicit mode and
// a broken model are never papered over. `models ensure` (npm start's first
// step) only downloads when it has to.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveRetrieval, PRESETS } from '../src/retrieval/embedding.js';
import { DEFAULTS, configProblems, createConfigSource } from '../src/config/config.js';

const dir = mkdtempSync(join(tmpdir(), 'tinywebui-auto-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

const fake = { dim: 3, spec: { repoId: 'fake' } };
const failing = (code) => async () => { throw Object.assign(new Error(`boom ${code}`), { code }); };

test('hybrid through auto is the default', () => {
  assert.equal(DEFAULTS.retrieval.mode, 'auto');
  assert.deepEqual(configProblems({ ...DEFAULTS, authMode: 'none' }), []);
});

test('auto runs hybrid when the model loads', async () => {
  const r = await resolveRetrieval({ ...DEFAULTS.retrieval }, dir, async () => fake);
  assert.deepEqual(r, { mode: 'hybrid', embedder: fake, fallback: null });
});

test('auto falls back to lexical, with the reason, when the model is not installed', async () => {
  // The real loader against an empty models folder: no bundle there.
  const r = await resolveRetrieval({ ...DEFAULTS.retrieval }, join(dir, 'empty'));
  assert.equal(r.mode, 'lexical');
  assert.equal(r.embedder, null);
  assert.match(r.fallback, /no embedding bundle/);
});

test('an explicit hybrid or dense mode refuses to start without the model', async () => {
  for (const mode of ['hybrid', 'dense']) {
    await assert.rejects(resolveRetrieval({ ...DEFAULTS.retrieval, mode }, join(dir, 'empty')), /no embedding bundle/);
  }
});

test('a broken or mismatched model fails even under auto', async () => {
  await assert.rejects(resolveRetrieval({ ...DEFAULTS.retrieval }, dir, failing('CHECKSUM')), /boom CHECKSUM/);
});

test('lexical never touches the loader', async () => {
  const r = await resolveRetrieval({ ...DEFAULTS.retrieval, mode: 'lexical' }, dir, failing('SHOULD_NOT_LOAD'));
  assert.deepEqual(r, { mode: 'lexical', embedder: null, fallback: null });
});

test('$TINYWEBUI_RETRIEVAL_MODE opts out without a config file, and a typo is a config problem', () => {
  const was = process.env.TINYWEBUI_RETRIEVAL_MODE;
  try {
    process.env.TINYWEBUI_RETRIEVAL_MODE = 'lexical';
    assert.equal(createConfigSource({}).load({ persistSecret: false }).retrieval.mode, 'lexical');
    process.env.TINYWEBUI_RETRIEVAL_MODE = 'lexcal';
    const cfg = createConfigSource({}).load({ persistSecret: false });
    assert.match(configProblems(cfg).join(), /retrieval.mode must be one of/);
  } finally {
    if (was === undefined) delete process.env.TINYWEBUI_RETRIEVAL_MODE; else process.env.TINYWEBUI_RETRIEVAL_MODE = was;
  }
});

// `models ensure` as a subprocess, with fetch replaced so any download attempt fails loudly.
const BIN = fileURLToPath(new URL('../bin/tinywebui.js', import.meta.url));
const NO_NET = join(dir, 'no-net.mjs');
writeFileSync(NO_NET, 'globalThis.fetch = async (url) => { throw new Error(`network used: ${url}`); };\n');
const ensure = (config, extraEnv = {}) => {
  const home = mkdtempSync(join(dir, 'ensure-'));
  writeFileSync(join(home, 'tinywebui.config.json'), JSON.stringify(config));
  const env = { ...process.env, ...extraEnv };
  delete env.TINYWEBUI_CONFIG; delete env.TINYWEBUI_MCP; delete env.TINYWEBUI_MODELS_DIR;
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(NO_NET).href, BIN, 'models', 'ensure'], { cwd: home, env, encoding: 'utf8' });
  return { home, code: r.status, err: r.stderr };
};

test('ensure does nothing for lexical, a custom bundle, or a model already there', () => {
  assert.equal(ensure({ retrieval: { mode: 'lexical' } }).code, 0);
  assert.equal(ensure({}, { TINYWEBUI_RETRIEVAL_MODE: 'lexical' }).code, 0);
  assert.equal(ensure({ retrieval: { model: 'mine', modelDir: join(dir, 'custom') } }).code, 0);

  const home = mkdtempSync(join(dir, 'ensure-present-'));
  const bundle = join(home, 'models', PRESETS.fast.localDir);
  mkdirSync(bundle, { recursive: true });
  writeFileSync(join(bundle, 'model.onnx'), 'x');
  writeFileSync(join(bundle, 'tokenizer.json'), '{}');
  writeFileSync(join(home, 'tinywebui.config.json'), '{}');
  const env = { ...process.env };
  delete env.TINYWEBUI_CONFIG; delete env.TINYWEBUI_MODELS_DIR;
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(NO_NET).href, BIN, 'models', 'ensure'], { cwd: home, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /network used/);
});

test('ensure under auto never blocks a start when the download fails; explicit hybrid does', () => {
  const auto = ensure({});
  assert.equal(auto.code, 0);
  assert.match(auto.err, /network used[\s\S]*starting with lexical search/);

  const hybrid = ensure({ retrieval: { mode: 'hybrid' } });
  assert.equal(hybrid.code, 1);
  assert.match(hybrid.err, /network used/);
});
