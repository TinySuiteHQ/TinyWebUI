import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { FILE_ONLY, mergeAccess, keyClass, validateConfig } from '../access/policy.js';
import { modelProblems, labelFor } from './models.js';
import { logger } from '../log.js';

const log = logger('config');

const CONFIG_FILE = process.env.TINYWEBUI_CONFIG
  ? resolve(process.env.TINYWEBUI_CONFIG)
  : resolve(process.cwd(), 'tinywebui.config.json');

// MCP wiring lives in its own Claude-Desktop-shaped file, next to the config.
const MCP_FILE = process.env.TINYWEBUI_MCP
  ? resolve(process.env.TINYWEBUI_MCP)
  : resolve(dirname(CONFIG_FILE), 'mcp.json');

export const DEFAULTS = {
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: '',
  // A cheap, fast, tool-capable default that caches well on a stable prefix and
  // needs no cache_control fields. Any OpenAI-compatible model id works.
  model: 'deepseek/deepseek-v4.1-flash',
  // The model catalog (see src/config/models.js). Empty: any model id goes. Listed:
  // only these can be picked, `model` names one by id, and people see each
  // entry's label, with its own prompt and sampling settings if it has them.
  models: [],
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
  maxToolRounds: 12,
  // How long an ask_user question waits for an answer before the run carries
  // on without one, on the model's own assumptions. 0 waits until the user
  // answers or stops the run.
  askUserTimeoutSeconds: 120,
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
  // follow-up question without an expand_context round.
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
  // Total request budget (including schemas and reserved output). 0 uses
  // maxHistoryTokens as a conservative fallback, not model auto-detection.
  contextWindowTokens: 0,
  contextReserveTokens: 8192,
  llmCompaction: true,
  compactionMaxTokens: 2048,
  // auto: direct DeepSeek uses reasoning_content, OpenRouter uses details.
  // Explicit override for custom compatible gateways.
  reasoningReplay: 'auto',
  // IANA zone the model is told the date in (and uses for automations). Empty
  // means the server's own zone.
  timezone: '',
  // Which tool calls wait for the user (see src/config/approval.js).
  //   'writes'  ask before any call not declared read-only (default)
  //   'all'     ask before every call
  //   'off'     never ask
  // Scheduled runs have no one to ask, so a call that would ask is refused.
  toolApproval: 'writes',
  // Per-tool overrides, by flat name: always ask / never ask.
  confirmTools: [],
  autoApproveTools: [],
  // Cap on what one expand_context call may return.
  expandCharBudget: 8000,
  // Flat tool names switched off from the settings panel -- built-in or an
  // MCP server's, named exactly as buildBody sends them. Filtered out of what
  // is offered to the model; a server can still be reached by name, so this
  // is a per-tool block, not a substitute for disabling the whole server.
  disabledTools: [],
  // Optional auth/RBAC. Off by default -- TinyWebUI stays single-user and
  // local-first unless this is deliberately opted into for a managed deploy.
  //   'none'           no login: just you, on localhost (default)
  //   'single'         just you, behind a password (authPassword or
  //                    $TINYWEBUI_PASSWORD; set it with `tinywebui set-password`)
  //   'trusted-header' many users: an upstream gateway (Cloudflare Access,
  //                    oauth2-proxy, Authelia, ...) signs people in with
  //                    Google, Apple, SSO etc. and passes identity headers
  authMode: 'none',
  // Level 'single': an scrypt hash (never plaintext), from `tinywebui
  // set-password`; never writable through /api/config.
  authPassword: '',
  // Signs session cookies. Auto-generated on first run when auth is enabled
  // and this is empty; never sent to the frontend.
  sessionSecret: '',
  // Reserved for a native OAuth login ('multiuser'), not implemented yet --
  // use 'trusted-header' behind a gateway for Google/Apple/SSO sign-in.
  googleClientId: '',
  googleClientSecret: '',
  googleRedirectUri: '',
  // Emails auto-approved as admin the first time they sign in -- how the
  // first admin account is bootstrapped.
  adminEmails: [],
  sessionTtlDays: 30,
  // Level 'trusted-header': an upstream gateway (Cloudflare Access, oauth2-
  // proxy, ...) authenticates and injects identity headers on every request.
  // Headers are believed only from peers inside trustedProxyCidrs; startup
  // refuses an empty list. Users are provisioned on first sight.
  trustedProxyCidrs: [],
  trustedUserIdHeader: 'x-tinysuite-user-id',
  trustedEmailHeader: 'x-tinysuite-email',
  trustedNameHeader: 'x-tinysuite-name',
  trustedRoleHeader: 'x-tinysuite-role',
  // Where "log out" sends the browser (e.g. the Access logout URL).
  logoutUrl: '',
  // Extra origins allowed to send state-changing requests (e.g. an admin
  // tool on another host). The page's own origin is always allowed.
  allowedOrigins: [],
  // false: refuse to start on a database that needs migrating; run
  // `tinywebui migrate` as its own deployment step instead.
  autoMigrate: true,
  // true: nothing in the control plane can change from the UI or API --
  // settings, tools, MCP servers. Change the files and reload instead.
  frozen: false,
  // read_document and search_chats ranking. 'lexical' is SQLite FTS5 BM25 and
  // needs nothing extra. 'dense' and 'hybrid' use a local ONNX embedding
  // bundle (fetched by `npm start` / `tinywebui models ensure`, or baked into
  // the Docker image -- never by the server) and the onnxruntime-node +
  // @huggingface/tokenizers optional dependencies. 'auto' is hybrid when both
  // are there and lexical, with a warning, when they are not.
  retrieval: {
    mode: 'auto',             // auto | lexical | dense | hybrid
    model: 'fast',            // fast | balanced | quality (TinySearch's presets) | multilingual, or a name with modelDir
    modelDir: '',             // bundle folder; default models/<preset> next to the config
    modelSha256: '',          // pin model.onnx; startup refuses a different file
    denseWeight: 0.5,         // hybrid: dense share of the fused ranking, BM25 gets the rest
    rrfK: 60,
    queryPrefix: '',          // e.g. bge: 'Represent this sentence for searching relevant passages: '
    documentPrefix: '',
    // Small-to-big: PASSAGES are what read_document returns (every mode);
    // CHUNKS are what gets embedded -- as long as the model reads (256
    // tokens for fast, 512 for bge), so only their overlap is set here.
    passageSize: 1800,        // characters per passage
    passageOverlap: 200,      // characters shared by neighbouring passages
    chunkOverlap: 32,         // tokens shared by neighbouring chunks
  },
};

/**
 * One instance's view of its configuration.
 *
 * Layers, lowest first: DEFAULTS < config file < env vars < `opts.config`.
 * Keys set in code are locked: the UI cannot change them, since a saved value
 * would be shadowed on the very next load anyway. `configFile: false` means no
 * file is read or written; UI changes then live in memory for this process.
 * `mcpServers` in code likewise replaces mcp.json and locks the MCP editor.
 */
export function createConfigSource(opts = {}) {
  const code = opts.config || {};
  const file = opts.configFile === false ? null
    : opts.configFile ? resolve(opts.configFile) : CONFIG_FILE;
  const mcpFile = opts.mcpFile ? resolve(opts.mcpFile)
    : file && file !== CONFIG_FILE ? resolve(dirname(file), 'mcp.json') : MCP_FILE;
  const codeServers = opts.mcpServers || null;
  const locked = new Set(Object.keys(code));
  let memory = {}; // stands in for the file when there is none

  const readFile = () => {
    if (!file) return { ...memory };
    if (!existsSync(file)) return {};
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`Bad config at ${file}: ${err.message}`);
    }
  };
  const writeFile = (obj) => {
    if (!file) { memory = obj; return; }
    writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
  };

  function load({ persistSecret = true } = {}) {
    const env = {};
    if (process.env.TINYWEBUI_BASE_URL) env.baseUrl = process.env.TINYWEBUI_BASE_URL;
    if (process.env.TINYWEBUI_API_KEY) env.apiKey = process.env.TINYWEBUI_API_KEY;
    if (process.env.OPENROUTER_API_KEY) env.apiKey = process.env.OPENROUTER_API_KEY;
    if (process.env.TINYWEBUI_MODEL) env.model = process.env.TINYWEBUI_MODEL;
    // Secrets can come from the environment, so committed config never holds them.
    if (process.env.TINYWEBUI_SESSION_SECRET) env.sessionSecret = process.env.TINYWEBUI_SESSION_SECRET;

    const fromFile = readFile();
    const cfg = { ...DEFAULTS, ...fromFile, ...env, ...code };
    if (fromFile.access !== undefined || code.access !== undefined) cfg.access = mergeAccess(fromFile.access, code.access);
    // Partial retrieval blocks fill in from the defaults rather than replace them.
    // $TINYWEBUI_RETRIEVAL_MODE=lexical is the no-config way to opt out of hybrid.
    const envRetrieval = process.env.TINYWEBUI_RETRIEVAL_MODE ? { mode: process.env.TINYWEBUI_RETRIEVAL_MODE } : {};
    cfg.retrieval = { ...DEFAULTS.retrieval, ...(fromFile.retrieval || {}), ...envRetrieval, ...(code.retrieval || {}) };
    // No silent fallbacks: a bad value is reported by configProblems() and
    // refuses to start, rather than quietly becoming a default (a mistyped
    // authMode used to become 'none').
    if (typeof cfg.baseUrl === 'string') cfg.baseUrl = cfg.baseUrl.replace(/\/+$/, '');
    // A session secret is required the moment auth is on; generate and persist
    // one rather than signing cookies with an empty key.
    if (cfg.authMode !== 'none' && !cfg.sessionSecret && persistSecret) {
      cfg.sessionSecret = randomBytes(32).toString('hex');
      try {
        writeFile({ ...readFile(), sessionSecret: cfg.sessionSecret });
      } catch (err) {
        log.error(`could not persist generated sessionSecret: ${err.message}`);
      }
    }
    return cfg;
  }

  /** Applies the writable, unlocked part of `patch`; locked keys are an error. */
  function save(patch) {
    if (isFrozen()) throw new LockedError('this deployment is frozen: change its files instead');
    const fileOnly = Object.keys(patch).filter((k) => FILE_ONLY.has(k));
    if (fileOnly.length) throw new LockedError(`set in files only, not editable here: ${fileOnly.join(', ')}`);
    const blocked = Object.keys(patch).filter((k) => WRITABLE.has(k) && locked.has(k));
    if (blocked.length) throw new LockedError(`set in code, not editable here: ${blocked.join(', ')}`);
    const current = readFile();
    for (const [k, v] of Object.entries(patch)) {
      if (WRITABLE.has(k)) current[k] = v;
    }
    // Validate what the file would become before writing it.
    const problems = configProblems({ ...DEFAULTS, ...current, ...code });
    if (problems.length) throw new Error(problems.join('; '));
    writeFile(current);
    return load();
  }

  // `frozen` may be set in code or in the file; code wins, like any key.
  function isFrozen() {
    if (code.frozen !== undefined) return Boolean(code.frozen);
    try { return Boolean(readFile().frozen); } catch { return false; }
  }
  const lockedNow = () => (isFrozen() ? new Set([...locked, ...WRITABLE]) : locked);

  const readMcp = () => {
    if (codeServers) return JSON.stringify({ mcpServers: codeServers }, null, 2) + '\n';
    if (!existsSync(mcpFile)) return '{\n  "mcpServers": {}\n}\n';
    return readFileSync(mcpFile, 'utf8');
  };

  return {
    load,
    save,
    public: (cfg) => ({
      ...publicConfig(cfg), lockedKeys: [...lockedNow()], mcpLocked: Boolean(codeServers) || isFrozen(),
      keyClasses: Object.fromEntries([...WRITABLE, ...FILE_ONLY].map((k) => [k, keyClass(k, lockedNow())]))
    }),
    lockedKeys: () => new Set(lockedNow()),
    /** The raw mcp.json (or code) server map, throwing on bad JSON -- for tooling that must not guess. */
    strictMcpServers() {
      const parsed = JSON.parse(readMcp());
      return parsed.mcpServers || parsed;
    },
    /** Users pinned in code's access.users: admins cannot overrule these. */
    codeAccessUsers: () => ({ ...(code.access?.users || {}) }),
    /** Low-level access for the policy write-back: read and replace the JSON file. */
    readFile,
    writeFile,
    path: () => file,
    mcpPath: () => (codeServers ? null : mcpFile),
    get mcpLocked() { return Boolean(codeServers) || isFrozen(); },
    isFrozen,
    dbPath: (cfg) => {
      const set = opts.dbPath || process.env.TINYWEBUI_DB || cfg?.dbPath;
      if (set === ':memory:') return set;
      return set ? resolve(set) : resolve(dirname(file || CONFIG_FILE), 'tinywebui.db');
    },
    /** Raw text of mcp.json, so the editor round-trips comments-free but verbatim. */
    readMcpFile: readMcp,
    loadMcpServers() {
      try {
        const parsed = JSON.parse(readMcp());
        // Accept both {"mcpServers": {...}} and a bare {...} map.
        return parsed.mcpServers || parsed || {};
      } catch (err) {
        log.error(`${mcpFile} is not valid JSON: ${err.message}`);
        return {};
      }
    },
    /** Validates before writing, so a typo cannot leave an unparseable file behind. */
    saveMcpFile(text) {
      if (codeServers) throw new LockedError('MCP servers are set in code, not editable here');
      if (isFrozen()) throw new LockedError('this deployment is frozen: change mcp.json instead');
      const parsed = JSON.parse(text);
      const servers = parsed.mcpServers || parsed;
      for (const [name, spec] of Object.entries(servers)) {
        if (!spec || (!spec.command && !spec.url)) {
          throw new Error(`"${name}" needs either "command" (stdio) or "url" (http)`);
        }
      }
      writeFileSync(mcpFile, text.endsWith('\n') ? text : text + '\n');
      return servers;
    },
  };
}

export class LockedError extends Error {}

// Keys that are not in DEFAULTS but are still settings.
const EXTRA_KEYS = new Set(['access']);
const ENUMS = {
  reasoningReplay: ['auto', 'omit', 'reasoning_content', 'reasoning_details'],
  authMode: ['none', 'single', 'multiuser', 'trusted-header'],
  cacheTtl: ['5m', '1h'],
  cacheMode: ['auto', 'implicit', 'explicit', 'rolling', 'off'],
  toolApproval: ['writes', 'all', 'off'],
};
const kind = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

/**
 * Every problem with a loaded config: unknown keys (usually typos), values of
 * the wrong type or outside their allowed set, plus the policy checks in
 * validateConfig(). Startup, reload, save and `tinywebui validate` all refuse
 * a config with any.
 */
function retrievalProblems(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return ['retrieval must be an object'];
  const out = [];
  for (const k of Object.keys(r)) if (!(k in DEFAULTS.retrieval)) out.push(`unknown setting "retrieval.${k}"`);
  if (r.mode !== undefined && !['auto', 'lexical', 'dense', 'hybrid'].includes(r.mode)) out.push('retrieval.mode must be one of auto, lexical, dense, hybrid');
  for (const k of ['model', 'modelDir', 'modelSha256', 'queryPrefix', 'documentPrefix']) {
    if (r[k] !== undefined && typeof r[k] !== 'string') out.push(`retrieval.${k} must be a string`);
  }
  if (r.modelSha256 && !/^[0-9a-fA-F]{64}$/.test(r.modelSha256)) out.push('retrieval.modelSha256 must be a 64-character hex sha256');
  if (r.denseWeight !== undefined && !(typeof r.denseWeight === 'number' && r.denseWeight > 0 && r.denseWeight < 1)) {
    out.push('retrieval.denseWeight must be a number between 0 and 1 (exclusive); use mode "dense" or "lexical" for the extremes');
  }
  if (r.rrfK !== undefined && !(Number.isInteger(r.rrfK) && r.rrfK >= 0)) out.push('retrieval.rrfK must be a whole number >= 0');
  const size = r.passageSize ?? DEFAULTS.retrieval.passageSize;
  if (!(Number.isInteger(size) && size >= 200 && size <= 20000)) out.push('retrieval.passageSize must be a whole number of characters from 200 to 20000');
  if (r.passageOverlap !== undefined && !(Number.isInteger(r.passageOverlap) && r.passageOverlap >= 0 && r.passageOverlap < size / 2)) {
    out.push('retrieval.passageOverlap must be a whole number >= 0 and under half of passageSize');
  }
  if (r.chunkOverlap !== undefined && !(Number.isInteger(r.chunkOverlap) && r.chunkOverlap >= 0 && r.chunkOverlap <= 128)) {
    out.push('retrieval.chunkOverlap must be a whole number of tokens from 0 to 128');
  }
  return out;
}

export function configProblems(cfg) {
  const problems = [];
  for (const [key, value] of Object.entries(cfg)) {
    if (!(key in DEFAULTS) && !EXTRA_KEYS.has(key)) { problems.push(`unknown setting "${key}"`); continue; }
    if (ENUMS[key]) {
      if (!ENUMS[key].includes(value)) problems.push(`${key} must be one of ${ENUMS[key].join(', ')} (got ${JSON.stringify(value)})`);
      continue;
    }
    if (key === 'models') continue; // modelProblems, below, knows the shape
    if (key === 'retrieval') {
      problems.push(...retrievalProblems(value));
      continue;
    }
    if (key === 'frozen' || key === 'autoMigrate') {
      if (typeof value !== 'boolean') problems.push(`${key} must be true or false`);
      continue;
    }
    if (!(key in DEFAULTS)) continue;
    if (['contextWindowTokens', 'contextReserveTokens', 'compactionMaxTokens'].includes(key)) {
      if (!(Number.isInteger(value) && value >= (key === 'contextWindowTokens' ? 0 : 256))) {
        problems.push(`${key} must be a whole number >= ${key === 'contextWindowTokens' ? 0 : 256}`);
      }
      continue;
    }
    if (key === 'askUserTimeoutSeconds') {
      if (!(Number.isInteger(value) && value >= 0)) problems.push('askUserTimeoutSeconds must be a whole number of seconds >= 0 (0: no timeout)');
      continue;
    }
    const want = kind(DEFAULTS[key]);
    const got = kind(value);
    // A null default is an optional number (temperature, maxTokens).
    const ok = want === 'null' ? got === 'null' || (got === 'number' && Number.isFinite(value))
      : want === 'number' ? got === 'number' && Number.isFinite(value)
      : got === want;
    if (!ok) problems.push(`${key} must be ${want === 'null' ? 'a number or null' : `a${want === 'array' || want === 'object' ? 'n' : ''} ${want}`} (got ${got})`);
  }
  return [...problems, ...modelProblems(cfg), ...validateConfig(cfg)];
}

// Only the knobs the UI is allowed to change. Secrets stay server-side.
export const WRITABLE = new Set([
  'model', 'systemPrompt', 'temperature', 'maxTokens', 'maxToolRounds', 'askUserTimeoutSeconds',
  'cacheTtl', 'cacheMode', 'compactThreshold', 'keepTurns', 'maxInlineChars',
  'compactMinSaved', 'maxTurnChars', 'maxHistoryTokens', 'timezone',
  'toolApproval', 'confirmTools', 'autoApproveTools', 'disabledTools'
]);

export function publicConfig(cfg) {
  const { apiKey, authPassword, sessionSecret, googleClientSecret, ...rest } = cfg;
  return {
    ...rest,
    modelLabel: labelFor(cfg, cfg.model),
    hasApiKey: Boolean(apiKey),
    hasGoogleAuth: Boolean(cfg.googleClientId),
  };
}

// The file-driven instance the CLI has always used, kept as plain functions.
const fileSource = createConfigSource();
export const configPath = () => fileSource.path();
export const mcpPath = () => fileSource.mcpPath();
export const dbPath = (cfg) => fileSource.dbPath(cfg);
export const readMcpFile = () => fileSource.readMcpFile();
export const loadMcpServers = () => fileSource.loadMcpServers();
export const saveMcpFile = (text) => fileSource.saveMcpFile(text);
export const loadConfig = () => fileSource.load();
export const saveConfig = (patch) => fileSource.save(patch);
