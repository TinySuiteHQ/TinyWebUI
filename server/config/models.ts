/**
 * The model catalog: which models people may pick, what they are called, and
 * how each one is prompted and sampled. Declared in the config file:
 *
 *   models: [
 *     { id: 'fast', label: 'Quick', model: 'deepseek/deepseek-v4.1-flash',
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
import type { CacheMode, ExtraBody, ReasoningReplay, ThinkingLevel, ThinkingSend } from '../harness/types.ts';
import type { RoleSettings } from '../access/policy.ts';
import { REASONING_REPLAYS, THINKING_CHOICES as SHARED_THINKING_CHOICES, THINKING_SENDS, type CacheTtl, type ThinkingChoice } from '../../shared/settings.ts';


/**
 * How a model thinks, set by an admin per entry. `default` is what a turn
 * uses; `choices` are the levels a person may pick from the composer (one, or
 * none, means the level is fixed). `send` says which request field carries it
 * when the endpoint is not one the provider table recognises.
 */
export interface ThinkingSpec { default?: ThinkingChoice; choices?: ThinkingChoice[]; send?: ThinkingSend }

/**
 * A level an entry may offer: one sent to the provider, or `provider`, which
 * sends nothing so the provider's own default applies. Kept out of the
 * harness's ThinkingLevel: on the wire it is the absence of a level.
 */
export type { ThinkingChoice };

export interface ModelEntry {
  id: string;
  model?: string;
  label?: string;
  description?: string;
  enabled?: boolean;
  connector?: string;
  /** People may send this model images. On unless false. */
  images?: boolean;
  /** The model is offered tools. On unless false: off is for a model that cannot call them. */
  tools?: boolean;
  /** Older form: what the model can do. Still read (see takesImages); the editor writes images/tools instead. */
  tags?: string[];
  systemPrompt?: string;
  temperature?: number | null;
  maxTokens?: number | null;
  maxToolRounds?: number;
  cacheMode?: CacheMode;
  cacheTtl?: CacheTtl;
  extraBody?: ExtraBody;
  reasoningReplay?: ReasoningReplay;
  thinking?: ThinkingSpec;
}

/** A named endpoint; `models` only in the file's nested shape (see flattenCatalog). */
export interface Connector { id: string; label?: string; baseUrl: string; apiKey?: string; models?: ModelEntry[] }

/** The part of the config the catalog lives in. */
export interface CatalogConfig { model: string; models: ModelEntry[]; connectors: Connector[] }

/** Per-model settings that replace the global value for that model's turns. */
export const MODEL_OVERRIDES: (keyof ModelEntry & string)[] = ['systemPrompt', 'temperature', 'maxTokens', 'maxToolRounds', 'cacheMode', 'cacheTtl', 'extraBody', 'reasoningReplay'];

/** Values of `reasoningReplay`; see reasoningReplay in harness/provider.ts. */
export const REASONING_REPLAY: ReasoningReplay[] = [...REASONING_REPLAYS];

export const THINKING_CHOICES: ThinkingChoice[] = [...SHARED_THINKING_CHOICES];
export const THINKING_SEND: ThinkingSend[] = [...THINKING_SENDS];

/** The older `tags` values, accepted so configs that list them still load. */
export const LEGACY_TAGS = ['vision', 'reasoning', 'tools'];

const ENTRY_KEYS = new Set(['id', 'model', 'label', 'description', 'enabled', 'connector', 'images', 'tools', 'tags', 'thinking', ...MODEL_OVERRIDES]);

/**
 * The file keeps each model with the endpoint that serves it: top-level
 * `models` run on the default baseUrl/apiKey, `connectors[i].models` on that
 * connector, and every entry carries its own prompt, sampling and caching.
 * At runtime the catalog is one flat list whose entries name their connector,
 * so nothing past loading knows about the nesting. The older flat file shape
 * (entries with `connector: <id>`) loads unchanged.
 */
// Raw input: the file's contents, before validation.
export function flattenCatalog(cfg: Record<string, any>): { connectors?: Connector[]; models?: ModelEntry[] } {
  if (!Array.isArray(cfg.connectors) || !Array.isArray(cfg.models ?? [])) return {};
  const nested: ModelEntry[] = [];
  const connectors = cfg.connectors.map((c) => {
    if (!c || typeof c !== 'object' || !Array.isArray(c.models)) return c;
    const { models, ...rest } = c;
    for (const m of models) nested.push(m && typeof m === 'object' && !Array.isArray(m) ? { ...m, connector: c.id } : m);
    return rest;
  });
  return { connectors, models: [...(cfg.models ?? []), ...nested] };
}

/** The flat runtime catalog back in the file's nested shape. */
export function nestCatalog(cfg: Record<string, any>): { connectors?: Connector[]; models?: ModelEntry[] } {
  const out: { connectors?: Connector[]; models?: ModelEntry[] } = {};
  const connectors: Connector[] = Array.isArray(cfg.connectors) ? cfg.connectors : [];
  const models: ModelEntry[] = Array.isArray(cfg.models) ? cfg.models : [];
  const ids = new Set(connectors.map((c) => c?.id));
  // An entry naming a connector that is not listed stays flat, so validation
  // still reports it instead of the entry silently moving endpoints.
  if (cfg.models !== undefined) out.models = models.filter((m) => !m?.connector || !ids.has(m.connector));
  if (cfg.connectors !== undefined) {
    out.connectors = connectors.map((c) => {
      const mine = models.filter((m) => m?.connector && m.connector === c?.id).map(({ connector, ...m }) => m);
      return mine.length ? { ...c, models: mine } : c;
    });
  }
  return out;
}

/**
 * Whether turns on `key` have somewhere to go: an entry's connector, else the
 * top-level endpoint if it has a URL. A key is optional either way: a local
 * server may need none.
 */
export function hasEndpoint(cfg: Partial<CatalogConfig> & { baseUrl?: string }, key?: string | null): boolean {
  const e = findEntry(cfg, key ?? cfg.model);
  return e?.connector && findConnector(cfg, e.connector) ? true : Boolean(cfg.baseUrl);
}

/**
 * Named endpoints: { id, label?, baseUrl, apiKey? }. The top-level
 * baseUrl/apiKey are the endpoint of a model that names none, for a
 * deployment set up in code or the environment; unset by default.
 */
export const connectors = (cfg: Partial<CatalogConfig>): Connector[] => (Array.isArray(cfg.connectors) ? cfg.connectors : []);
export const findConnector = (cfg: Partial<CatalogConfig>, id: string) => connectors(cfg).find((c) => c.id === id) || null;

export const catalog = (cfg: Partial<CatalogConfig>): ModelEntry[] => (Array.isArray(cfg.models) ? cfg.models : []);
// Closed whenever entries are listed, even if all are disabled: parking every
// model must not reopen the picker to the provider's whole list.
export const isClosed = (cfg: Partial<CatalogConfig>) => catalog(cfg).length > 0;
export const enabledEntries = (cfg: Partial<CatalogConfig>) => catalog(cfg).filter((e) => e.enabled !== false);

/** The default model: `model` as set, or unset with a catalog, its first enabled entry. */
export const defaultModel = (cfg: Partial<CatalogConfig>): string => cfg.model || enabledEntries(cfg)[0]?.id || '';

/** The enabled entry `key` names: by id, or by its provider model id (the default `model` may be either). */
export function findEntry(cfg: Partial<CatalogConfig>, key: string | null | undefined): ModelEntry | null {
  const list = enabledEntries(cfg);
  return list.find((e) => e.id === key) || list.find((e) => (e.model || e.id) === key) || null;
}

/** What people call a model: its label in the catalog, else the id itself. */
export function labelFor(cfg: Partial<CatalogConfig>, key: string): string {
  const e = findEntry(cfg, key);
  return e ? e.label || e.id : key;
}

/** What the picker lists for one entry. Prompts and knobs stay server-side. */
export const publicEntry = (e: ModelEntry) => ({ id: e.id, name: e.label || e.id, description: e.description || null });

/**
 * Whether people may send this model images. On unless an admin switched it
 * off; an older entry whose tags leave out `vision` stays off, as it was.
 * No entry (an open catalog) means nothing is known, so nothing is refused.
 */
export const takesImages = (e: ModelEntry | null | undefined): boolean =>
  !e || (e.images ?? !(e.tags?.length && !e.tags.includes('vision')));

/** Whether this model is offered tools. On unless an admin switched it off. */
export const usesTools = (e: ModelEntry | null | undefined): boolean => !e || e.tools !== false;

/**
 * The levels a person may pick and the one they get otherwise, or null when
 * there is nothing to pick and nothing to send. Without a `default` it is the
 * provider's own, unless the admin left that out of the choices.
 */
export function thinkingView(spec: ThinkingSpec | undefined): { default: ThinkingChoice; choices: ThinkingChoice[] } | null {
  if (!spec) return null;
  const choices = spec.choices?.length ? THINKING_CHOICES.filter((l) => spec.choices!.includes(l)) : [];
  const fallback = !choices.length || choices.includes('provider') ? 'provider' : choices.includes('medium') ? 'medium' : choices[0];
  const level = spec.default ?? fallback;
  const offered = choices.length > 1 ? choices : [level];
  return offered.length === 1 && level === 'provider' ? null : { default: level, choices: offered };
}

/**
 * What one turn on `key` thinks at and how it is sent: the level the person
 * asked for when the entry offers it, else the entry's default. Null when
 * nothing is sent: the entry says nothing about thinking, or the level is
 * the provider's own.
 */
export function thinkingFor(cfg: Partial<CatalogConfig>, key: string | null | undefined, asked?: unknown): { level: ThinkingLevel; send: ThinkingSend } | null {
  const e = findEntry(cfg, key ?? cfg.model);
  const view = thinkingView(e?.thinking);
  if (!view) return null;
  const level = view.choices.find((l) => l === asked) || view.default;
  return level === 'provider' ? null : { level, send: e!.thinking!.send || 'auto' };
}

/**
 * What a role's settings replace in a turn's config, last of all: a role is
 * the admin's word for those people, over the global value and a model's own.
 * `model` (picked before the turn, in modelFor) and the question timeout (read
 * when a question is asked) are applied where they are used instead.
 */
const ROLE_OVERRIDES = ['systemPrompt', 'temperature', 'maxTokens', 'maxToolRounds', 'toolApproval'] as const satisfies readonly (keyof RoleSettings)[];

/**
 * The config one turn runs with: the entry's overrides over the global
 * settings and its provider id as `model`, then the person's role's settings
 * over both. extraBody merges, so an entry can add a reasoning knob without
 * restating the gateway's routing.
 */
export function effectiveConfig<C extends CatalogConfig & { baseUrl: string; apiKey: string; extraBody: ExtraBody }>(cfg: C, key?: string | null, role: RoleSettings = {}): C {
  const out = entryConfig(cfg, key);
  const set = ROLE_OVERRIDES.filter((k) => role[k] !== undefined);
  if (!set.length) return out;
  const withRole = { ...out };
  for (const k of set) (withRole as Record<string, unknown>)[k] = role[k];
  return withRole;
}

function entryConfig<C extends CatalogConfig & { baseUrl: string; apiKey: string; extraBody: ExtraBody }>(cfg: C, key?: string | null): C {
  const e = findEntry(cfg, key ?? cfg.model);
  if (!e) return key && key !== cfg.model ? { ...cfg, model: key } : cfg;
  const out = { ...cfg };
  for (const k of MODEL_OVERRIDES) if (e[k] !== undefined) (out as Record<string, unknown>)[k] = e[k];
  out.extraBody = { ...(cfg.extraBody || {}), ...(e.extraBody || {}) };
  // `provider` merges one level deeper: a global data policy (zdr,
  // data_collection) must survive an entry that only pins its routing.
  if (cfg.extraBody?.provider || e.extraBody?.provider) {
    out.extraBody.provider = { ...(cfg.extraBody?.provider || {}), ...(e.extraBody?.provider || {}) };
  }
  out.model = e.model || e.id;
  // The entry's endpoint replaces the global one; provider.js only ever reads
  // cfg.baseUrl and cfg.apiKey, so nothing downstream knows about connectors.
  const conn = e.connector ? findConnector(cfg, e.connector) : null;
  if (conn) {
    out.baseUrl = String(conn.baseUrl).replace(/\/+$/, '');
    out.apiKey = conn.apiKey || '';
  }
  return out;
}

/** Every problem with the connector list. */
export function connectorProblems(cfg: Record<string, any>): string[] {
  const list = cfg.connectors;
  if (list === undefined) return [];
  if (!Array.isArray(list)) return ['connectors must be a list of { id, baseUrl, apiKey?, label?, models? } entries'];
  const out: string[] = [];
  const ids = new Set();
  list.forEach((c: any, i: number) => {
    const at = `connectors[${i}]`;
    if (!c || typeof c !== 'object' || Array.isArray(c)) { out.push(`${at} must be an object`); return; }
    if (typeof c.id !== 'string' || !c.id.trim()) { out.push(`${at}.id must be a non-empty string`); return; }
    if (ids.has(c.id)) out.push(`${at}.id "${c.id}" is listed twice`);
    ids.add(c.id);
    // A nested `models` that is a list was already lifted out by flattenCatalog.
    if (c.models !== undefined) out.push(`${at}.models must be a list of model entries`);
    for (const k of Object.keys(c)) if (!['id', 'label', 'baseUrl', 'apiKey', 'models'].includes(k)) out.push(`${at}.${k} is not a known setting (known: id, label, baseUrl, apiKey, models)`);
    for (const k of ['label', 'apiKey']) if (c[k] !== undefined && typeof c[k] !== 'string') out.push(`${at}.${k} must be a string`);
    try {
      if (!/^https?:$/.test(new URL(c.baseUrl).protocol)) throw new Error('scheme');
    } catch { out.push(`${at}.baseUrl must be an http(s) URL`); }
  });
  for (const [i, e] of (Array.isArray(cfg.models) ? cfg.models : []).entries()) {
    if (e?.connector !== undefined && !ids.has(e.connector)) out.push(`models[${i}].connector "${e.connector}" is not in connectors`);
  }
  return out;
}

function thinkingProblems(t: any, at: string): string[] {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return [`${at} must be an object like { default: 'provider', choices: ['provider', 'low', 'high'] }`];
  const out: string[] = [];
  for (const k of Object.keys(t)) if (!['default', 'choices', 'send'].includes(k)) out.push(`${at}.${k} is not a known setting (known: default, choices, send)`);
  if (t.default !== undefined && !THINKING_CHOICES.includes(t.default)) out.push(`${at}.default must be one of ${THINKING_CHOICES.join(', ')}`);
  if (t.choices !== undefined) {
    if (!(Array.isArray(t.choices) && t.choices.every((l: ThinkingChoice) => THINKING_CHOICES.includes(l)))) out.push(`${at}.choices must be a list from ${THINKING_CHOICES.join(', ')}`);
    else if (t.default !== undefined && t.choices.length && !t.choices.includes(t.default)) out.push(`${at}.default "${t.default}" must be one of its choices`);
  }
  if (t.send !== undefined && !THINKING_SEND.includes(t.send)) out.push(`${at}.send must be one of ${THINKING_SEND.join(', ')}`);
  return out;
}

const NUMERIC: Record<string, string> = { temperature: 'a number or null', maxTokens: 'a number or null' };

/** Every problem with the catalog and what refers into it. */
export function modelProblems(cfg: Record<string, any>): string[] {
  const list = cfg.models;
  if (list === undefined) return [];
  if (!Array.isArray(list)) return ['models must be a list of { id, model?, label?, ... } entries'];
  const out: string[] = [];
  const ids = new Set();
  list.forEach((e: any, i: number) => {
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
    if (e.reasoningReplay !== undefined && !REASONING_REPLAY.includes(e.reasoningReplay)) out.push(`${at}.reasoningReplay must be one of ${REASONING_REPLAY.join(', ')}`);
    if (e.cacheTtl !== undefined && !['5m', '1h'].includes(e.cacheTtl)) out.push(`${at}.cacheTtl must be 5m or 1h`);
    if (e.enabled !== undefined && typeof e.enabled !== 'boolean') out.push(`${at}.enabled must be true or false`);
    if (e.connector !== undefined && typeof e.connector !== 'string') out.push(`${at}.connector must be a connector id`);
    if (e.tags !== undefined && !(Array.isArray(e.tags) && e.tags.every((t: string) => LEGACY_TAGS.includes(t)))) out.push(`${at}.tags must be a list from ${LEGACY_TAGS.join(', ')}`);
    for (const k of ['images', 'tools']) if (e[k] !== undefined && typeof e[k] !== 'boolean') out.push(`${at}.${k} must be true or false`);
    if (e.extraBody !== undefined && !(e.extraBody && typeof e.extraBody === 'object' && !Array.isArray(e.extraBody))) out.push(`${at}.extraBody must be an object`);
    if (e.thinking !== undefined) out.push(...thinkingProblems(e.thinking, `${at}.thinking`));
  });
  if (!list.length || out.length) return out;
  // A closed catalog: everything that names a model has to name an entry.
  // Role lists may name disabled entries (they just drop out); the default may not.
  // An unset `model` is the first enabled entry (see defaultModel).
  const on = enabledEntries(cfg).map((e) => e.id);
  if (!on.length) out.push('every entry in models is disabled: enable at least one');
  else if (cfg.model && !findEntry(cfg, cfg.model)) {
    const off = list.some((e: any) => e.id === cfg.model || e.model === cfg.model);
    out.push(`model "${cfg.model}" ${off ? 'is disabled' : 'is not in the models catalog'}; enabled ids: ${on.join(', ')}`);
  }
  for (const [role, spec] of Object.entries<any>(cfg.access?.roles || {})) {
    if (!Array.isArray(spec?.models)) continue;
    for (const m of spec.models) if (!ids.has(m)) out.push(`access.roles.${role}.models: "${m}" is not a models catalog id`);
  }
  for (const [role, spec] of Object.entries<any>(cfg.access?.roles || {})) {
    const m = spec?.settings?.model;
    if (typeof m === 'string' && m && !ids.has(m)) out.push(`access.roles.${role}.settings.model: "${m}" is not a models catalog id`);
    for (const m of Object.keys(spec?.modelSettings && typeof spec.modelSettings === 'object' ? spec.modelSettings : {})) {
      if (!ids.has(m)) out.push(`access.roles.${role}.modelSettings: "${m}" is not a models catalog id`);
    }
  }
  return out;
}
