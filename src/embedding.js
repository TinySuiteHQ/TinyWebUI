import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Local ONNX sentence embeddings for document retrieval, done the way
 * TinySearch and TinyContext do it: the same model bundles (ONNX graph plus
 * tokenizer files from the same Hugging Face repos), CPU inference, the same
 * pooling and normalisation per model, and a model key stored with every
 * vector so a model change re-embeds instead of mixing vectors.
 *
 * One deliberate difference: those services fetch a missing bundle on first
 * start. TinyWebUI never downloads anything at runtime -- a bundle is a
 * deployment artifact, fetched explicitly with `tinywebui models pull` (or
 * baked into an image) and optionally pinned by checksum.
 *
 * onnxruntime-node and @huggingface/tokenizers are optional peers, loaded
 * only when retrieval.mode is 'dense' or 'hybrid'. Lexical installs never
 * need them.
 */

// Mirrors TinySearch's _PRESET_MODELS (services/embedding_service.py).
export const PRESETS = {
  fast: {
    repoId: 'onnx-models/all-MiniLM-L6-v2-onnx',
    localDir: 'all-minilm-l6-v2-onnx',
    onnxPaths: ['model.onnx'],
    pooling: 'auto',
    normalize: false,
    maxLength: 256,
    files: ['model.onnx', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json', 'vocab.txt']
  },
  balanced: {
    repoId: 'BAAI/bge-small-en-v1.5',
    localDir: 'bge-small-en-v1.5-onnx',
    onnxPaths: ['onnx/model.onnx', 'model.onnx'],
    pooling: 'cls',
    normalize: true,
    maxLength: 512,
    files: ['onnx/model.onnx', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json', 'vocab.txt', 'config.json']
  },
  quality: {
    repoId: 'BAAI/bge-base-en-v1.5',
    localDir: 'bge-base-en-v1.5-onnx',
    onnxPaths: ['onnx/model.onnx', 'model.onnx'],
    pooling: 'cls',
    normalize: true,
    maxLength: 512,
    files: ['onnx/model.onnx', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json', 'vocab.txt', 'config.json']
  }
};

/** Where bundles live unless retrieval.modelDir says otherwise. */
export function defaultModelsDir(configPath) {
  if (process.env.TINYWEBUI_MODELS_DIR) return resolve(process.env.TINYWEBUI_MODELS_DIR);
  return resolve(configPath ? join(configPath, '..') : process.cwd(), 'models');
}

/**
 * The model a retrieval config names: a preset (by name) with its bundle
 * directory, or a custom bundle given by modelDir (pooling 'auto', no
 * normalisation, 512 tokens -- TinySearch's defaults for custom models).
 */
export function resolveModel(retrieval, modelsDir) {
  const name = retrieval.model || 'fast';
  const preset = PRESETS[name];
  if (preset) return { name, ...preset, dir: retrieval.modelDir ? resolve(retrieval.modelDir) : join(modelsDir, preset.localDir) };
  if (!retrieval.modelDir) throw new Error(`retrieval.model "${name}" is not a preset (${Object.keys(PRESETS).join(', ')}); set retrieval.modelDir for a custom bundle`);
  return {
    name, repoId: name, localDir: null, dir: resolve(retrieval.modelDir),
    onnxPaths: ['model.onnx', 'onnx/model.onnx'], pooling: 'auto', normalize: false, maxLength: 512, files: []
  };
}

export function findOnnxFile(spec) {
  for (const rel of spec.onnxPaths) {
    const p = join(spec.dir, rel);
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return null;
}

export async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * Identifies the vectors a model produces. Like TinyContext's
 * embedding_model_key: model identity plus a digest of the document prefix,
 * and here the file checksum too, so a swapped model file never reuses old
 * vectors.
 */
export function modelKey(spec, onnxSha256, documentPrefix = '', chunkOverlap = 32) {
  const prefix = createHash('sha256').update(documentPrefix).digest('hex').slice(0, 12);
  // Chunking is part of what a stored vector means: a different overlap
  // cuts different chunks, so it re-embeds rather than mixing.
  return `onnx:${spec.repoId}:${onnxSha256.slice(0, 16)}:document-prefix:${prefix}:chunks:${spec.maxLength}/${chunkOverlap}`;
}

async function importPeer(name) {
  try { return await import(name); } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (package|module)/.test(err?.message || '')) {
      throw new Error(`retrieval.mode 'dense'/'hybrid' needs optional packages: npm install onnxruntime-node @huggingface/tokenizers (missing ${name})`);
    }
    throw err;
  }
}

const l2normalize = (v) => {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1e-12;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
};

/**
 * Loads a bundle and returns { key, dim, embed(texts) -> Float32Array[] }.
 * Fails clearly -- missing packages, missing bundle, checksum mismatch --
 * and never reaches the network.
 */
export async function loadEmbedder(retrieval, modelsDir) {
  const spec = resolveModel(retrieval, modelsDir);
  const onnxPath = findOnnxFile(spec);
  const tokenizerPath = join(spec.dir, 'tokenizer.json');
  if (!onnxPath || !existsSync(tokenizerPath)) {
    const hint = PRESETS[spec.name] ? `run: tinywebui models pull ${spec.name}` : 'the bundle needs an ONNX model and tokenizer.json';
    throw new Error(`no embedding bundle at ${spec.dir} (${hint}); TinyWebUI never downloads models at runtime`);
  }
  const actual = await sha256File(onnxPath);
  if (retrieval.modelSha256 && retrieval.modelSha256.toLowerCase() !== actual) {
    throw new Error(`embedding model checksum mismatch for ${onnxPath}: expected ${retrieval.modelSha256}, got ${actual}`);
  }

  // ONNX Runtime ships telemetry; a local, private deployment keeps it off
  // unless the operator explicitly says otherwise.
  process.env.ORT_DISABLE_TELEMETRY ??= '1';
  const ort = await importPeer('onnxruntime-node');
  const { Tokenizer } = await importPeer('@huggingface/tokenizers');
  const configPath = join(spec.dir, 'tokenizer_config.json');
  const tokenizer = new Tokenizer(
    JSON.parse(readFileSync(tokenizerPath, 'utf8')),
    existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {}
  );
  const session = await ort.InferenceSession.create(onnxPath, { executionProviders: ['cpu'] });
  const inputNames = new Set(session.inputNames);
  const pooledOutput = session.outputNames.includes('sentence_embedding') ? 'sentence_embedding' : null;

  const encode = (text) => {
    let { ids } = tokenizer.encode(text);
    // Truncate like TinySearch's enable_truncation: keep the closing special token.
    if (ids.length > spec.maxLength) ids = [...ids.slice(0, spec.maxLength - 1), ids[ids.length - 1]];
    return ids;
  };

  // The model's own wrapper tokens ([CLS] … [SEP] for the BERT-family presets).
  const wrapper = tokenizer.encode('').ids;
  const open = wrapper.length >= 1 ? wrapper.slice(0, 1) : [];
  const close = wrapper.length >= 2 ? wrapper.slice(-1) : [];
  const chunkOverlap = retrieval.chunkOverlap ?? 32;
  /**
   * Small-to-big: a passage (what read_document returns) is cut into chunks
   * (what gets embedded). Chunk length is the model's own token limit --
   * 256 for `fast`, 512 for the bge presets -- so every token of a passage
   * is embedded somewhere; neighbouring chunks overlap by chunkOverlap
   * tokens so a sentence cut at a boundary still lands whole in one of them.
   */
  const chunksOf = (text) => {
    const body = tokenizer.encode(text, { add_special_tokens: false }).ids;
    const room = spec.maxLength - open.length - close.length;
    if (body.length <= room) return [[...open, ...body, ...close]];
    const out = [];
    for (let start = 0; start < body.length; start += room - chunkOverlap) {
      out.push([...open, ...body.slice(start, start + room), ...close]);
      if (start + room >= body.length) break;
    }
    return out;
  };

  // One run at a time, like TinySearch's _EMBED_LOCK: ORT sessions are not
  // meant for overlapping runs, and CPU inference gains nothing from it.
  let queue = Promise.resolve();
  const runLocked = (fn) => { const next = queue.then(fn, fn); queue = next.catch(() => {}); return next; };

  async function embedBatch(encoded) {
    const texts = encoded;
    const maxLen = Math.max(1, ...encoded.map((ids) => ids.length));
    const n = texts.length;
    const ids = new BigInt64Array(n * maxLen);
    const mask = new BigInt64Array(n * maxLen);
    encoded.forEach((row, r) => row.forEach((id, c) => { ids[r * maxLen + c] = BigInt(id); mask[r * maxLen + c] = 1n; }));
    const feeds = {};
    const dims = [n, maxLen];
    if (inputNames.has('input_ids')) feeds.input_ids = new ort.Tensor('int64', ids, dims);
    if (inputNames.has('attention_mask')) feeds.attention_mask = new ort.Tensor('int64', mask, dims);
    if (inputNames.has('token_type_ids')) feeds.token_type_ids = new ort.Tensor('int64', new BigInt64Array(n * maxLen), dims);

    const results = await session.run(feeds);
    let rows;
    const pick = (rank) => Object.values(results).find((t) => t.dims.length === rank);
    const pooled = pooledOutput ? results[pooledOutput] : spec.pooling === 'cls' ? null : pick(2);
    if (pooled) {
      const dim = pooled.dims[1];
      rows = Array.from({ length: n }, (_, r) => Float32Array.from(pooled.data.subarray(r * dim, (r + 1) * dim)));
    } else {
      // CLS pooling: the first token's hidden state.
      const tokens = pick(3);
      if (!tokens) throw new Error(`ONNX model ${spec.repoId} has no usable embedding output`);
      const [, seq, dim] = tokens.dims;
      rows = Array.from({ length: n }, (_, r) => Float32Array.from(tokens.data.subarray(r * seq * dim, r * seq * dim + dim)));
    }
    return spec.normalize ? rows.map(l2normalize) : rows;
  }

  async function embedIds(idLists) {
    const out = [];
    for (let i = 0; i < idLists.length; i += 32) out.push(...await runLocked(() => embedBatch(idLists.slice(i, i + 32))));
    return out;
  }

  /** One vector per text, truncated to the model's length (queries). */
  const embed = (texts) => embedIds(texts.map(encode));

  /** Each passage as its chunks' vectors: Float32Array[][] (passage -> chunks). */
  async function embedPassages(texts) {
    const chunks = texts.map(chunksOf);
    const flat = await embedIds(chunks.flat());
    let i = 0;
    return chunks.map((c) => c.map(() => flat[i++]));
  }

  const [probe] = await embed(['probe']);
  return {
    key: modelKey(spec, actual, retrieval.documentPrefix || '', chunkOverlap),
    chunkTokens: spec.maxLength,
    dim: probe.length,
    spec,
    sha256: actual,
    embed,
    embedPassages,
    close: () => session.release?.()
  };
}

/** Files a preset bundle consists of, for `tinywebui models pull`. */
export function bundleListing(dir) {
  const out = [];
  const walk = (d, rel = '') => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p, `${rel}${name}/`);
      else out.push(`${rel}${name}`);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
}
