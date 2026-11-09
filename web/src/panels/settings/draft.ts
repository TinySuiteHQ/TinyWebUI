/**
 * The settings draft: the Models, Model defaults and Chat behaviour pages all
 * edit this one object, so moving between them loses nothing and one Save
 * writes it all. Built from
 * /api/config, turned back into a config patch on save. Keys are write-only:
 * a blank key field means "keep it".
 */
import { newId } from '../../core/id.ts';
import * as SETTING from '../../../../shared/settings.ts';
import { LEVEL_NAMES } from '../../chat/composer/levels.ts';

// /api/config is a wide shape read field by field.
type Json = any;

// The values come from shared/settings.ts, which the server validates
// against; a label is required for each (Record<T, string>), so a value added
// there does not compile here until it reads as something.
const options = <T extends string>(values: readonly T[], labels: Record<T, string>): [string, string][] =>
  values.map((v) => [v, labels[v]]);

export const CACHE_MODES = options(SETTING.CACHE_MODES, {
  auto: 'Automatic', implicit: 'Stable prefix only', explicit: 'Anthropic cache_control', rolling: 'OpenRouter automatic', off: 'Off'
});
export const CACHE_TTLS = options(SETTING.CACHE_TTLS, { '5m': '5 minutes', '1h': '1 hour' });
export const REASONING_REPLAY = options(SETTING.REASONING_REPLAYS, {
  auto: 'Automatic', omit: 'Never', reasoning_content: 'reasoning_content', reasoning_details: 'reasoning_details'
});
export const LEVELS = options(SETTING.THINKING_CHOICES, LEVEL_NAMES);
export const TOOL_APPROVALS = options(SETTING.TOOL_APPROVALS, { writes: 'MCP tools that write', all: 'Every MCP tool call', off: 'Never ask' });
// How the level reaches the provider; 'auto' guesses from the endpoint (thinkingStyle in harness/provider.ts).
export const SENDS = options(SETTING.THINKING_SENDS, {
  auto: 'Auto: guess from the endpoint',
  effort: 'reasoning_effort (OpenAI, Gemini, Ollama, vLLM)',
  openrouter: 'reasoning.effort (OpenRouter)',
  anthropic: 'thinking budget (Anthropic)',
  switch: 'enable_thinking on/off (Qwen-style local templates)'
});

/**
 * The settings a model may override. Each inherits the global value of the
 * same key (on "Model defaults") while blank.
 */
export type OverrideSpec = { key: string, section: string, label: string, type: 'textarea' | 'number' | 'select' | 'json', note?: string, attrs?: Record<string, number>, options?: [string, string][] };
export const OVERRIDES: OverrideSpec[] = [
  { key: 'systemPrompt', section: 'Prompt', label: 'System prompt', type: 'textarea', note: 'Replaces the default prompt for this model.' },
  { key: 'temperature', section: 'Sampling', label: 'Temperature', type: 'number', attrs: { step: 0.1, min: 0, max: 2 } },
  { key: 'maxTokens', section: 'Sampling', label: 'Max output tokens', type: 'number', attrs: { min: 1 } },
  { key: 'maxToolRounds', section: 'Tools', label: 'Max tool turns', type: 'number', attrs: { min: 1, max: 50 }, note: 'Tool calls allowed per reply.' },
  { key: 'cacheMode', section: 'Caching', label: 'Cache style', type: 'select', options: CACHE_MODES },
  { key: 'cacheTtl', section: 'Caching', label: 'Prompt cache lifetime', type: 'select', options: CACHE_TTLS },
  { key: 'reasoningReplay', section: 'Advanced', label: 'Replay past reasoning', type: 'select', options: REASONING_REPLAY },
  { key: 'extraBody', section: 'Advanced', label: 'Extra request body (JSON)', type: 'json', note: 'Merged over the default body.' }
];
export const SECTIONS = ['Prompt', 'Sampling', 'Tools', 'Caching', 'Advanced'];

export type ConnectorDraft = {
  key: string, id: string, savedId: string, label: string, baseUrl: string,
  apiKey: string, clearKey: boolean, hasApiKey: boolean, keyHint: string
};
export type ModelDraft = {
  key: string, id: string, label: string, description: string, model: string, connector: string,
  enabled: boolean, images: boolean, tools: boolean,
  overrides: Record<string, string>,
  thinking: { level: string, send: string, picks: string[] }
};

/** The form fields, kept as the strings their inputs hold until a patch is built. */
export type Form = Record<string, string>;

export type Draft = {
  form: Form,
  connectors: ConnectorDraft[],
  models: ModelDraft[],
  /** Whether the top-level endpoint serves anything (set in code or the environment). */
  defaultEndpoint: boolean,
  defaultKey: { set: boolean, hint: string }
};

const str = (v: unknown, fallback = '') => (v == null ? fallback : String(v));

export function connectorDraft(c: Json = {}): ConnectorDraft {
  return { key: newId(), id: c.id || '', savedId: c.id || '', label: c.label || '', baseUrl: c.baseUrl || '', apiKey: '', clearKey: false, hasApiKey: Boolean(c.hasApiKey), keyHint: c.keyHint || '' };
}

export function modelDraft(m: Json = {}): ModelDraft {
  const overrides: Record<string, string> = {};
  for (const spec of OVERRIDES) {
    const v = m[spec.key];
    overrides[spec.key] = v == null ? '' : spec.type === 'json' ? JSON.stringify(v, null, 2) : String(v);
  }
  const t = m.thinking;
  return {
    key: newId(), id: m.id || '', label: m.label || '', description: m.description || '', model: m.model || '', connector: m.connector || '',
    enabled: m.enabled !== false,
    // On unless switched off. An older entry's tags without `vision` meant
    // images off, and still do (takesImages in config/models.ts).
    images: m.images ?? !(m.tags?.length && !m.tags.includes('vision')),
    tools: m.tools !== false,
    overrides,
    // A model without thinking settings starts with Default ticked, so offering
    // a level keeps it; a saved fixed level (no choices) stays fixed.
    thinking: { level: t?.default || 'provider', send: t?.send || 'auto', picks: t ? [...(t.choices || [])] : ['provider'] }
  };
}

export function fromConfig(cfg: Json): Draft {
  const form: Form = {
    systemPrompt: str(cfg.systemPrompt),
    model: str(cfg.model),
    temperature: str(cfg.temperature),
    maxTokens: str(cfg.maxTokens),
    maxToolRounds: str(cfg.maxToolRounds),
    askUserTimeoutSeconds: str(cfg.askUserTimeoutSeconds, '120'),
    cacheTtl: str(cfg.cacheTtl, '5m'),
    compactThreshold: str(cfg.compactThreshold, '0'),
    keepTurns: str(cfg.keepTurns, '2'),
    maxInlineChars: str(cfg.maxInlineChars, '0'),
    maxTurnChars: str(cfg.maxTurnChars, '0'),
    compactMinSaved: str(cfg.compactMinSaved, '0'),
    maxHistoryTokens: str(cfg.maxHistoryTokens, '0'),
    cacheMode: str(cfg.cacheMode, 'auto'),
    timezone: str(cfg.timezone),
    baseUrl: str(cfg.baseUrl),
    apiKey: '',
    llmCompaction: String(cfg.llmCompaction !== false),
    compactionMaxTokens: str(cfg.compactionMaxTokens, '8192'),
    expandCharBudget: str(cfg.expandCharBudget, '8000'),
    cache: String(cfg.cache !== false),
    reasoningReplay: str(cfg.reasoningReplay, 'auto'),
    extraBody: Object.keys(cfg.extraBody || {}).length ? JSON.stringify(cfg.extraBody, null, 2) : ''
  };
  return {
    form,
    connectors: (cfg.connectors || []).map(connectorDraft),
    models: (cfg.models || []).map(modelDraft),
    defaultEndpoint: Boolean(cfg.usesDefaultEndpoint),
    defaultKey: { set: Boolean(cfg.hasApiKey), hint: cfg.keyHint || '' }
  };
}

// A number input's v-model holds a number once typed in, a string before: read both.
const text = (v: unknown) => (v == null ? '' : String(v));
const num = (v: unknown) => (text(v).trim() === '' ? null : Number(v));

function readConnector(c: ConnectorDraft) {
  return {
    id: c.id.trim(),
    ...(c.label.trim() ? { label: c.label.trim() } : {}),
    baseUrl: c.baseUrl.trim(),
    // undefined keeps the stored key on the server; null clears it.
    ...(c.apiKey ? { apiKey: c.apiKey } : c.clearKey ? { apiKey: null } : {})
  };
}

/** The levels a model offers: every ticked one, and its default always. */
export const pickedLevels = (t: ModelDraft['thinking']) => LEVELS.map(([v]) => v).filter((v) => t.picks.includes(v) || v === t.level);

function readThinking(t: ModelDraft['thinking']) {
  const choices = pickedLevels(t);
  // Only the provider's default: nothing to pick or send, so no settings at all.
  if (choices.every((v) => v === 'provider')) return undefined;
  return { default: t.level, ...(choices.length > 1 ? { choices } : {}), ...(t.send !== 'auto' ? { send: t.send } : {}) };
}

function readModel(m: ModelDraft) {
  const name = m.id.trim();
  const out: Json = {
    id: name,
    ...(m.label.trim() ? { label: m.label.trim() } : {}),
    ...(m.description.trim() ? { description: m.description.trim() } : {}),
    ...(m.model.trim() ? { model: m.model.trim() } : {}),
    ...(m.connector ? { connector: m.connector } : {})
  };
  if (!m.images) out.images = false;
  if (!m.tools) out.tools = false;
  if (!m.enabled) out.enabled = false;
  for (const spec of OVERRIDES) {
    const raw = text(m.overrides[spec.key]).trim();
    if (raw === '') continue;
    if (spec.type === 'number') out[spec.key] = Number(raw);
    else if (spec.type === 'json') {
      let v;
      try { v = JSON.parse(raw); } catch (err) { throw new Error(`model "${name}" ${spec.label}: ${err.message}`); }
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`model "${name}" ${spec.label} must be a JSON object`);
      out[spec.key] = v;
    } else out[spec.key] = spec.key === 'systemPrompt' ? m.overrides[spec.key] : raw;
  }
  const think = readThinking(m.thinking);
  if (think) out.thinking = think;
  return out;
}

/** The config patch the draft holds. Throws on bad JSON. */
export function buildPatch(d: Draft, { admin, lockedKeys }: { admin: boolean, lockedKeys: Set<string> }): Json {
  const f = d.form;
  const patch: Json = {
    systemPrompt: f.systemPrompt,
    model: (f.model || '').trim(),
    temperature: num(f.temperature),
    maxTokens: num(f.maxTokens),
    maxToolRounds: Number(f.maxToolRounds) || 12,
    askUserTimeoutSeconds: Math.max(0, Math.round(Number(f.askUserTimeoutSeconds) || 0)),
    cacheTtl: f.cacheTtl,
    compactThreshold: Number(f.compactThreshold) || 0,
    keepTurns: Number(f.keepTurns) || 2,
    maxInlineChars: Number(f.maxInlineChars) || 0,
    maxTurnChars: Number(f.maxTurnChars) || 0,
    compactMinSaved: Number(f.compactMinSaved) || 0,
    maxHistoryTokens: Number(f.maxHistoryTokens) || 0,
    cacheMode: f.cacheMode,
    // toolApproval is not here: the MCP page saves it as it changes, and a
    // stale copy in the draft would undo that on the next Save.
    timezone: f.timezone
  };
  if (admin) {
    const catalog = { connectors: d.connectors.map(readConnector), models: d.models.map(readModel) };
    // A default that is no longer an enabled entry (renamed, removed, or none
    // picked yet) becomes the first enabled one, as the server would read it.
    const on = catalog.models.filter((m) => m.enabled !== false);
    if (on.length && !on.some((m) => m.id === patch.model || (m.model || m.id) === patch.model)) patch.model = on[0].id;
    Object.assign(patch, {
      // The top-level endpoint only while it is shown; saving it otherwise
      // would bring the card back with nothing on it.
      ...(d.defaultEndpoint ? { baseUrl: (f.baseUrl || '').trim(), ...(f.apiKey ? { apiKey: f.apiKey } : {}) } : {}),
      llmCompaction: f.llmCompaction === 'true',
      compactionMaxTokens: Number(f.compactionMaxTokens) || 8192,
      expandCharBudget: Number(f.expandCharBudget) || 0,
      cache: f.cache === 'true',
      reasoningReplay: f.reasoningReplay,
      extraBody: (f.extraBody || '').trim() ? JSON.parse(f.extraBody || "{}") : {},
      ...catalog
    });
  }
  for (const k of lockedKeys) delete patch[k];
  return patch;
}

/** What a model's connection select offers: the connectors, the default endpoint when it serves, and its own value. */
export function connectorChoices(d: Draft, current: string): { value: string, label: string }[] {
  const ids = d.connectors.map((c) => c.id.trim()).filter(Boolean);
  const keepDefault = d.defaultEndpoint || (current === '' && !ids.length);
  return [
    ...(keepDefault ? [{ value: '', label: 'Default connection' }] : []),
    ...[...new Set([...ids, ...(current && !ids.includes(current) ? [current] : [])])].map((id) => ({ value: id, label: id }))
  ];
}
