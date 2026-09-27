/**
 * The model catalog: which models people may pick, what they are called, and
 * how each one is prompted and sampled. Declared in the config file:
 *
 *   models: [
 *     { id: 'fast', label: 'Quick', model: 'deepseek/deepseek-v4-flash-0731',
 *       description: 'Everyday questions', temperature: 0.3 },
 *     { id: 'deep', label: 'Thorough', model: 'anthropic/claude-sonnet-5',
 *       systemPrompt: '...', maxToolRounds: 20 }
 *   ]
 *
 * An empty catalog (the default) changes nothing: any model id goes. A
 * non-empty one is closed: only its entries can be picked, the configured
 * `model` and every role's `models` list name entries by `id`, and people see
 * `label`, never the provider's id. `enabled: false` parks an entry: it keeps
 * its settings but cannot be picked or run until switched back on. Pure, like
 * policy.js.
 */

/** Per-model settings that replace the global value for that model's turns. */
export const MODEL_OVERRIDES = ['systemPrompt', 'temperature', 'maxTokens', 'maxToolRounds', 'cacheMode', 'cacheTtl', 'extraBody'];

const ENTRY_KEYS = new Set(['id', 'model', 'label', 'description', 'enabled', ...MODEL_OVERRIDES]);

export const catalog = (cfg) => (Array.isArray(cfg.models) ? cfg.models : []);
// Closed whenever entries are listed, even if all are disabled: parking every
// model must not reopen the picker to the provider's whole list.
export const isClosed = (cfg) => catalog(cfg).length > 0;
export const enabledEntries = (cfg) => catalog(cfg).filter((e) => e.enabled !== false);

/** The enabled entry `key` names: by id, or by provider model id for older prefs. */
export function findEntry(cfg, key) {
  const list = enabledEntries(cfg);
  return list.find((e) => e.id === key) || list.find((e) => (e.model || e.id) === key) || null;
}

/** What people call a model: its label in the catalog, else the id itself. */
export function labelFor(cfg, key) {
  const e = findEntry(cfg, key);
  return e ? e.label || e.id : key;
}

/** What the picker lists for one entry. Prompts and knobs stay server-side. */
export const publicEntry = (e) => ({ id: e.id, name: e.label || e.id, description: e.description || null });

/**
 * The config one turn runs with: the entry's overrides over the global
 * settings and its provider id as `model`. extraBody merges, so an entry can
 * add a reasoning knob without restating the gateway's routing.
 */
export function effectiveConfig(cfg, key) {
  const e = findEntry(cfg, key ?? cfg.model);
  if (!e) return key && key !== cfg.model ? { ...cfg, model: key } : cfg;
  const out = { ...cfg };
  for (const k of MODEL_OVERRIDES) if (e[k] !== undefined) out[k] = e[k];
  out.extraBody = { ...(cfg.extraBody || {}), ...(e.extraBody || {}) };
  // `provider` merges one level deeper: a global data policy (zdr,
  // data_collection) must survive an entry that only pins its routing.
  if (cfg.extraBody?.provider || e.extraBody?.provider) {
    out.extraBody.provider = { ...(cfg.extraBody?.provider || {}), ...(e.extraBody?.provider || {}) };
  }
  out.model = e.model || e.id;
  return out;
}

const NUMERIC = { temperature: 'a number or null', maxTokens: 'a number or null' };

/** Every problem with the catalog and what refers into it. */
export function modelProblems(cfg) {
  const list = cfg.models;
  if (list === undefined) return [];
  if (!Array.isArray(list)) return ['models must be a list of { id, model?, label?, ... } entries'];
  const out = [];
  const ids = new Set();
  list.forEach((e, i) => {
    const at = `models[${i}]`;
    if (!e || typeof e !== 'object' || Array.isArray(e)) { out.push(`${at} must be an object`); return; }
    if (typeof e.id !== 'string' || !e.id.trim()) { out.push(`${at}.id must be a non-empty string`); return; }
    if (ids.has(e.id)) out.push(`${at}.id "${e.id}" is listed twice`);
    ids.add(e.id);
    for (const k of Object.keys(e)) if (!ENTRY_KEYS.has(k)) out.push(`${at}.${k} is not a known setting (known: ${[...ENTRY_KEYS].join(', ')})`);
    for (const k of ['model', 'label', 'description', 'systemPrompt']) {
      if (e[k] !== undefined && typeof e[k] !== 'string') out.push(`${at}.${k} must be a string`);
    }
    for (const k of Object.keys(NUMERIC)) {
      if (e[k] !== undefined && e[k] !== null && !(typeof e[k] === 'number' && Number.isFinite(e[k]))) out.push(`${at}.${k} must be ${NUMERIC[k]}`);
    }
    if (e.maxToolRounds !== undefined && !(Number.isInteger(e.maxToolRounds) && e.maxToolRounds >= 0)) out.push(`${at}.maxToolRounds must be a whole number >= 0`);
    if (e.cacheMode !== undefined && !['auto', 'implicit', 'explicit', 'rolling', 'off'].includes(e.cacheMode)) out.push(`${at}.cacheMode must be one of auto, implicit, explicit, rolling, off`);
    if (e.cacheTtl !== undefined && !['5m', '1h'].includes(e.cacheTtl)) out.push(`${at}.cacheTtl must be 5m or 1h`);
    if (e.enabled !== undefined && typeof e.enabled !== 'boolean') out.push(`${at}.enabled must be true or false`);
    if (e.extraBody !== undefined && !(e.extraBody && typeof e.extraBody === 'object' && !Array.isArray(e.extraBody))) out.push(`${at}.extraBody must be an object`);
  });
  if (!list.length || out.length) return out;
  // A closed catalog: everything that names a model has to name an entry.
  // Role lists may name disabled entries (they just drop out); the default may not.
  const on = enabledEntries(cfg).map((e) => e.id);
  if (!on.length) out.push('every entry in models is disabled: enable at least one');
  else if (!findEntry(cfg, cfg.model)) {
    const off = list.some((e) => e.id === cfg.model || e.model === cfg.model);
    out.push(`model "${cfg.model}" ${off ? 'is disabled' : 'is not in the models catalog'}; enabled ids: ${on.join(', ')}`);
  }
  for (const [role, spec] of Object.entries(cfg.access?.roles || {})) {
    if (!Array.isArray(spec?.models)) continue;
    for (const m of spec.models) if (!ids.has(m)) out.push(`access.roles.${role}.models: "${m}" is not a models catalog id`);
  }
  return out;
}
