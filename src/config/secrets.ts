/*
 * Secrets kept out of tinywebui.config.json. The config file says what the
 * deployment is -- endpoints, connectors, models, policy -- and is safe to
 * read, diff and share. A key is not part of that shape, so it lives in one
 * of two places instead:
 *
 *   "${NAME}" in the config   filled in from the environment (see refs.ts)
 *   tinywebui.secrets.json    beside the config, owner-only: what the settings
 *                             page saves, and the generated session secret
 *
 * A literal key still found in the config file is honoured, and moved into
 * the secrets file the next time the server starts. Pure functions only; the
 * files are read and written by createConfigSource().
 */
import { SECRET_KEYS } from '../access/policy.ts';
import { fillRefs, hasRef, missingRefs } from './refs.ts';

/** What tinywebui.secrets.json holds. Connector keys go by connector id. */
export interface Secrets {
  apiKey?: string;
  sessionSecret?: string;
  googleClientSecret?: string;
  authPassword?: string;
  connectors?: Record<string, { apiKey?: string }>;
}

type FileConfig = Record<string, any>;

const TOP = [...SECRET_KEYS] as (keyof Omit<Secrets, 'connectors'>)[];

/** A value that is a secret itself, rather than empty or a pointer to one. */
const literal = (v: unknown): v is string => typeof v === 'string' && v !== '' && !hasRef(v);

/** The literal secrets a file-shaped config holds, and the config without them. */
export function extractSecrets(file: FileConfig): { shape: FileConfig; found: Secrets; names: string[] } {
  const shape: FileConfig = { ...file };
  const found: Secrets = {};
  const names: string[] = [];
  for (const k of TOP) {
    if (!literal(shape[k])) continue;
    found[k] = shape[k];
    names.push(k);
    delete shape[k];
  }
  if (Array.isArray(shape.connectors)) {
    shape.connectors = shape.connectors.map((c: any) => {
      if (!c || typeof c !== 'object' || !literal(c.apiKey)) return c;
      (found.connectors ??= {})[c.id] = { apiKey: c.apiKey };
      names.push(`connectors.${c.id}.apiKey`);
      const { apiKey, ...rest } = c;
      return rest;
    });
  }
  return { shape, found, names };
}

/** Folds newly found secrets into the stored ones; the found ones win. */
export function mergeSecrets(stored: Secrets, found: Secrets): Secrets {
  const out: Secrets = { ...stored, ...found, connectors: { ...(stored.connectors || {}), ...(found.connectors || {}) } };
  if (!Object.keys(out.connectors!).length) delete out.connectors;
  return out;
}

/**
 * A file-shaped config with its secrets filled in: a reference from the
 * environment, a literal as written, anything absent from the secrets file.
 */
export function applySecrets(file: FileConfig, secrets: Secrets, env: NodeJS.ProcessEnv = process.env): FileConfig {
  const out: FileConfig = { ...file };
  for (const k of TOP) {
    if (hasRef(out[k])) out[k] = fillRefs(out[k], env);
    else if (!literal(out[k]) && secrets[k]) out[k] = secrets[k];
  }
  if (Array.isArray(out.connectors)) {
    out.connectors = out.connectors.map((c: any) => {
      if (!c || typeof c !== 'object') return c;
      if (hasRef(c.apiKey)) return { ...c, apiKey: fillRefs(c.apiKey, env) };
      const stored = secrets.connectors?.[c.id]?.apiKey;
      return !literal(c.apiKey) && stored ? { ...c, apiKey: stored } : c;
    });
  }
  return out;
}

/** References in the config file the environment does not satisfy, as problems. */
export function refProblems(file: FileConfig, env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  const check = (where: string, v: unknown) => {
    for (const name of missingRefs(v, env)) out.push(`${where} refers to \${${name}}, which is not set in TinyWebUI's environment`);
  };
  for (const k of TOP) check(k, file[k]);
  for (const c of Array.isArray(file.connectors) ? file.connectors : []) {
    if (c && typeof c === 'object') check(`connectors.${c.id}.apiKey`, c.apiKey);
  }
  return out;
}

/**
 * Splits a settings save. Keys typed into the page go to the secrets file and
 * leave the patch (an `apiKey: undefined` left in it drops any literal from
 * the config file); a "${NAME}" typed there is shape and stays in it. Sent
 * empty or left out, a key is unchanged; null clears it. A key the config
 * file takes from the environment cannot be overwritten from the page:
 * `refused` names those.
 *
 * `current` is the config file as it stands (catalog flattened).
 */
export function takeSecrets(patch: Record<string, any>, current: FileConfig, stored: Secrets):
  { patch: Record<string, any>; secrets: Secrets; refused: string[] } {
  const out = { ...patch };
  const secrets: Secrets = { ...stored, connectors: { ...(stored.connectors || {}) } };
  const refused: string[] = [];

  if ('apiKey' in out) {
    const v = out.apiKey;
    delete out.apiKey;
    if (v === undefined || v === '') { /* unchanged */ }
    else if (hasRef(current.apiKey) && !hasRef(v)) refused.push(`apiKey (comes from ${current.apiKey})`);
    else if (v === null) { delete secrets.apiKey; out.apiKey = undefined; }
    else if (hasRef(v)) { delete secrets.apiKey; out.apiKey = v; }
    else { secrets.apiKey = String(v); out.apiKey = undefined; }
  }

  if (Array.isArray(out.connectors)) {
    const old = new Map<unknown, any>((Array.isArray(current.connectors) ? current.connectors : []).map((c: any) => [c?.id, c]));
    const kept: Record<string, { apiKey?: string }> = {};
    out.connectors = out.connectors.map((c: any) => {
      if (!c || typeof c !== 'object') return c;
      const { apiKey, ...rest } = c;
      const prev = old.get(c.id);
      if (hasRef(prev?.apiKey) && !hasRef(apiKey)) {
        if (apiKey !== undefined && apiKey !== '' && apiKey !== null) refused.push(`connectors.${c.id}.apiKey (comes from ${prev.apiKey})`);
        return { ...rest, apiKey: prev.apiKey };
      }
      if (hasRef(apiKey)) return { ...rest, apiKey };
      if (apiKey === null) return rest;
      const key = apiKey === undefined || apiKey === ''
        ? secrets.connectors![c.id]?.apiKey ?? (literal(prev?.apiKey) ? prev.apiKey : undefined)
        : String(apiKey);
      if (key) kept[c.id] = { apiKey: key };
      return rest;
    });
    // A connector that is gone takes its key with it.
    secrets.connectors = kept;
  }
  if (!Object.keys(secrets.connectors!).length) delete secrets.connectors;
  return { patch: out, secrets, refused };
}
