import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

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
  // A cheap, fast, tool-capable default that caches well on a stable prefix and
  // needs no cache_control fields. Any OpenAI-compatible model id works.
  model: 'deepseek/deepseek-v4-flash-0731',
  systemPrompt: [
    'You are a direct, technically precise assistant.',
    '',
    'Answer the question that was asked. Lead with the answer, then the reasoning that',
    'changes what the reader does -- no preamble, no restating the question, no summary',
    'of what you just said. Match length to the question: a one-line question gets a',
    'one-line answer; only go long when the task itself has that much surface area.',
    '',
    'Use the tools available to you rather than guessing or asking the user for something',
    'a tool can tell you. Call a tool immediately when it can resolve the question --',
    'don\'t ask permission to look something up or run a read-only check. If a tool',
    'fails, say what failed and what you did instead, rather than silently retrying',
    'or inventing a plausible-looking result. If you still need to call a tool, make',
    'the call on its own and hold your answer until the result is back -- writing the',
    'full answer in the same reply as a pending tool call forces a wasted extra round',
    'just to say there is nothing left to add.',
    '',
    'Say plainly when you are unsure or when something is outside what you can verify.',
    'Never invent APIs, flags, file paths, figures or citations.',
    '',
    'Use markdown only where it earns its keep: code in fenced blocks with a language',
    'tag, tables for genuinely tabular data, lists for genuinely parallel items. Don\'t',
    'reach for headers, bold, or bullets to dress up a short answer that reads fine as',
    'plain sentences.'
  ].join('\n'),
  // null = let the provider decide. Setting max_tokens in particular silently
  // truncates on models that would happily write more.
  temperature: null,
  maxTokens: null,
  // How many rounds of tool calls one message may trigger before the loop is
  // cut off. Raise it for deep research, lower it to cap spend per message.
  maxToolRounds: 20,
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
  // Context compaction. Once the conversation history (system prompt and tool
  // definitions excluded) crosses `compactThreshold` tokens, tool results older
  // than the last `keepTurns` user messages are demoted to stubs -- once, and
  // then frozen, so the cost is a single cache miss rather than a rewritten
  // prefix on every turn. Set the threshold to 0 to disable.
  compactThreshold: 60000,
  keepTurns: 2,
  // An epoch is a full cache miss, so it only happens when stubbing would
  // remove at least this many characters from the window.
  compactMinSaved: 20000,
  // A single result larger than this is stubbed for every LATER turn the
  // moment it arrives; the turn that fetched it still reads it whole. High
  // enough that an ordinary page or search result stays readable for a
  // follow-up question without a context_expand round.
  maxInlineChars: 30000,
  // Hard cap: a result larger than this is stubbed even for the turn that
  // fetched it, since it would otherwise be resent in full on every remaining
  // round and can blow the window on its own.
  maxTurnChars: 120000,
  // Hard window. If the history is still larger than this many tokens after
  // compaction -- a long plain-text chat, where there is nothing to stub --
  // the oldest turns stop being sent (they stay in the transcript), cutting
  // back to half this size so it moves rarely. 0 disables it.
  maxHistoryTokens: 100000,
  // IANA zone the model is told the date in (and uses for automations). Empty
  // means the server's own zone.
  timezone: '',
  // Which tool calls wait for the user (see src/approval.js).
  //   'writes'  ask before any call not declared read-only (default)
  //   'all'     ask before every call
  //   'off'     never ask
  // Scheduled runs have no one to ask, so a call that would ask is refused.
  toolApproval: 'writes',
  // Per-tool overrides, by flat name: always ask / never ask.
  confirmTools: [],
  autoApproveTools: [],
  // Cap on what one context_expand call may return.
  expandCharBudget: 8000,
  // Flat tool names switched off from the settings panel -- built-in or an
  // MCP server's, named exactly as buildBody sends them. Filtered out of what
  // is offered to the model; a server can still be reached by name, so this
  // is a per-tool block, not a substitute for disabling the whole server.
  disabledTools: [],
  // Optional auth/RBAC. Off by default -- TinyWebUI stays single-user and
  // local-first unless this is deliberately opted into for a managed deploy.
  //   'none'      no login, no changes (default)
  //   'single'    one password gate, DB content encrypted at rest with a key
  //               derived from that password
  //   'multiuser' Google OAuth login, admin-approved accounts, per-user data
  authMode: 'none',
  // Level 'single': a password hash (never plaintext), set via setup, not the
  // general /api/config PATCH.
  authPassword: '',
  // Signs session cookies. Auto-generated on first run when auth is enabled
  // and this is empty; never sent to the frontend.
  sessionSecret: '',
  // Level 'multiuser': Google OAuth app credentials.
  googleClientId: '',
  googleClientSecret: '',
  googleRedirectUri: '',
  // Emails auto-approved as admin the first time they sign in -- how the
  // first admin account is bootstrapped.
  adminEmails: [],
  sessionTtlDays: 30,
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
  if (!['writes', 'all', 'off'].includes(cfg.toolApproval)) cfg.toolApproval = DEFAULTS.toolApproval;
  const AUTH_MODES = ['none', 'single', 'multiuser'];
  if (!AUTH_MODES.includes(cfg.authMode)) cfg.authMode = DEFAULTS.authMode;
  // A session secret is required the moment auth is on; generate and persist
  // one rather than signing cookies with an empty key.
  if (cfg.authMode !== 'none' && !cfg.sessionSecret) {
    cfg.sessionSecret = randomBytes(32).toString('hex');
    try {
      const current = existsSync(CONFIG_FILE) ? JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) : {};
      current.sessionSecret = cfg.sessionSecret;
      writeFileSync(CONFIG_FILE, JSON.stringify(current, null, 2) + '\n');
    } catch (err) {
      console.error(`[tinywebui] could not persist generated sessionSecret: ${err.message}`);
    }
  }
  return cfg;
}

// Only the knobs the UI is allowed to change. Secrets stay server-side.
const WRITABLE = new Set([
  'model', 'systemPrompt', 'temperature', 'maxTokens', 'maxToolRounds',
  'cacheTtl', 'cacheMode', 'compactThreshold', 'keepTurns', 'maxInlineChars',
  'compactMinSaved', 'maxTurnChars', 'maxHistoryTokens', 'timezone',
  'toolApproval', 'confirmTools', 'autoApproveTools', 'disabledTools'
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
  const { apiKey, authPassword, sessionSecret, googleClientSecret, ...rest } = cfg;
  return {
    ...rest,
    hasApiKey: Boolean(apiKey),
    hasGoogleAuth: Boolean(cfg.googleClientId),
  };
}
