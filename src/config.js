import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const CONFIG_FILE = process.env.TINYWEBUI_CONFIG
  ? resolve(process.env.TINYWEBUI_CONFIG)
  : resolve(process.cwd(), 'tinywebui.config.json');

// MCP wiring lives in its own Claude-Desktop-shaped file, next to the config.
const MCP_FILE = process.env.TINYWEBUI_MCP
  ? resolve(process.env.TINYWEBUI_MCP)
  : resolve(dirname(CONFIG_FILE), 'mcp.json');

const DEFAULTS = {
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: '',
  model: 'anthropic/claude-sonnet-5',
  systemPrompt: [
    'You are a direct, technically precise assistant.',
    '',
    'Answer the question that was asked. Lead with the answer, then the reasoning that',
    'changes what the reader does -- no preamble, no restating the question, no summary',
    'of what you just said.',
    '',
    'Use the tools available to you rather than guessing or asking the user for something',
    'a tool can tell you. If a tool fails, say what failed and what you did instead.',
    '',
    'Say plainly when you are unsure or when something is outside what you can verify.',
    'Never invent APIs, flags, file paths, figures or citations.'
  ].join('\n'),
  // null = let the provider decide. Setting max_tokens in particular silently
  // truncates on models that would happily write more.
  temperature: null,
  maxTokens: null,
  // How many rounds of tool calls one message may trigger before the loop is
  // cut off. Raise it for deep research, lower it to cap spend per message.
  maxToolRounds: 12,
  // Merged into every completion request. Gateway-specific knobs live here.
  // TinyWebUI adds OpenRouter session_id automatically; setting provider.order
  // yourself takes precedence over sticky routing, so only pin providers when
  // you deliberately want that behavior.
  extraBody: {},
  // Prompt caching is on by default, and for most backends -- including every
  // local runtime -- that means nothing more than a stable request prefix,
  // which costs nothing and needs no provider support.
  cache: true,
  // Which cache dialect to speak. 'auto' infers it from the endpoint and model
  // and is right for OpenRouter and for anything local; set it explicitly when
  // you are on a gateway TinyWebUI has not been taught about.
  //   'auto'     infer (default)
  //   'implicit' stable prefix only, no cache fields on the wire
  //   'explicit' Anthropic-style cache_control breakpoints in message content
  //   'rolling'  OpenRouter top-level automatic cache_control
  //   'off'      no cache shaping at all
  cacheMode: 'auto',
  // Anthropic cache writes default to five minutes. One hour costs more to write
  // but is useful for research chats with pauses between turns.
  cacheTtl: '5m',
  // Where conversations live. Tool output is kept whole here and only the
  // compacted form goes on the wire, so this file grows faster than the window.
  dbPath: '',
  // Context compaction. Once a request's prompt crosses `compactThreshold`,
  // tool results older than the last `keepTurns` user messages are demoted to
  // stubs -- once, and then frozen, so the cost is a single cache miss rather
  // than a rewritten prefix on every turn. Set the threshold to 0 to disable.
  compactThreshold: 60000,
  keepTurns: 2,
  // Safety valve: a single result larger than this is stubbed the moment it
  // arrives, before it can blow the window on its own. Appending a stub costs
  // no cache, so this is free -- it is high only to keep it out of the way.
  maxInlineChars: 40000,
  // Cap on what one context_expand call may return.
  expandCharBudget: 8000,
  // Flat tool names switched off from the settings panel -- built-in or an
  // MCP server's, named exactly as buildBody sends them. Filtered out of what
  // is offered to the model; a server can still be reached by name, so this
  // is a per-tool block, not a substitute for disabling the whole server.
  disabledTools: [],
};

export function configPath() {
  return CONFIG_FILE;
}

export function mcpPath() {
  return MCP_FILE;
}

/** Conversation database, resolved next to the config unless one is set. */
export function dbPath(cfg) {
  const set = process.env.TINYWEBUI_DB || cfg?.dbPath;
  return set ? resolve(set) : resolve(dirname(CONFIG_FILE), 'tinywebui.db');
}

/** Raw text of mcp.json, so the editor round-trips comments-free but verbatim. */
export function readMcpFile() {
  if (!existsSync(MCP_FILE)) return '{\n  "mcpServers": {}\n}\n';
  return readFileSync(MCP_FILE, 'utf8');
}

export function loadMcpServers() {
  try {
    const parsed = JSON.parse(readMcpFile());
    // Accept both {"mcpServers": {...}} and a bare {...} map.
    return parsed.mcpServers || parsed || {};
  } catch (err) {
    console.error(`[tinywebui] ${MCP_FILE} is not valid JSON: ${err.message}`);
    return {};
  }
}

/** Validates before writing, so a typo cannot leave an unparseable file behind. */
export function saveMcpFile(text) {
  const parsed = JSON.parse(text);
  const servers = parsed.mcpServers || parsed;
  for (const [name, spec] of Object.entries(servers)) {
    if (!spec || (!spec.command && !spec.url)) {
      throw new Error(`"${name}" needs either "command" (stdio) or "url" (http)`);
    }
  }
  writeFileSync(MCP_FILE, text.endsWith('\n') ? text : text + '\n');
  return servers;
}

export function loadConfig() {
  let file = {};
  if (existsSync(CONFIG_FILE)) {
    try {
      file = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    } catch (err) {
      throw new Error(`Bad config at ${CONFIG_FILE}: ${err.message}`);
    }
  }
  const env = {};
  if (process.env.TINYWEBUI_BASE_URL) env.baseUrl = process.env.TINYWEBUI_BASE_URL;
  if (process.env.TINYWEBUI_API_KEY) env.apiKey = process.env.TINYWEBUI_API_KEY;
  if (process.env.OPENROUTER_API_KEY) env.apiKey = process.env.OPENROUTER_API_KEY;
  if (process.env.TINYWEBUI_MODEL) env.model = process.env.TINYWEBUI_MODEL;

  const cfg = { ...DEFAULTS, ...file, ...env };
  cfg.baseUrl = cfg.baseUrl.replace(/\/+$/, '');
  if (!['5m', '1h'].includes(cfg.cacheTtl)) cfg.cacheTtl = DEFAULTS.cacheTtl;
  const MODES = ['auto', 'implicit', 'explicit', 'rolling', 'off'];
  if (!MODES.includes(cfg.cacheMode)) cfg.cacheMode = DEFAULTS.cacheMode;
  return cfg;
}

// Only the knobs the UI is allowed to change. Secrets stay server-side.
const WRITABLE = new Set([
  'model', 'systemPrompt', 'temperature', 'maxTokens', 'maxToolRounds',
  'cacheTtl', 'cacheMode', 'compactThreshold', 'keepTurns', 'maxInlineChars',
  'disabledTools'
]);

export function saveConfig(patch) {
  const current = existsSync(CONFIG_FILE)
    ? JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
    : {};
  for (const [k, v] of Object.entries(patch)) {
    if (WRITABLE.has(k)) current[k] = v;
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(current, null, 2) + '\n');
  return loadConfig();
}

export function publicConfig(cfg) {
  const { apiKey, ...rest } = cfg;
  return { ...rest, hasApiKey: Boolean(apiKey) };
}
