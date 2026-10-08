/**
 * manage_mcp -- lets the model add, change, remove and switch MCP servers in
 * mcp.json on the user's behalf.
 *
 * Two things make this tool different from the other built-ins:
 *
 * 1. A stdio server is a command run on this machine, so every call that
 *    changes something asks first (see `gated` in registerLocal and
 *    approvalFor), and an unattended run cannot use it at all.
 * 2. mcp.json holds credentials (headers, env, tokens in URLs). The model gets
 *    to write them but never to read them back: results carry the *names* of
 *    headers and env variables, never their values, and an update to either is
 *    a patch, so a key is never echoed back to change something next to it. A
 *    value written as `${NAME}` is filled in from TinyWebUI's environment at
 *    connect time (see expandRefs in mcp.js), which keeps the key out of the
 *    file and out of the chat altogether.
 *
 * The file is saved at once; the servers reconnect when the reply is finished
 * (server.js), so a turn never loses the tools it is in the middle of using.
 */

export const MANAGE_MCP = 'manage_mcp';

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const HEADER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// A value that is only a reference to the environment holds no secret, so it
// may be shown. Anything else about a header or env value is hidden.
const REF_ONLY = /^(?:(?:Bearer|Basic|Token)\s+)?\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;
const SECRETISH = /key|token|secret|pass|auth|bearer|credential/i;
const HIDDEN = '<hidden>';

const MAX_SERVERS = 30;
const MAX_ENTRIES = 20;
const MAX_ARGS = 50;
const MAX_VALUE = 4000;

export function mcpToolDef() {
  return {
    type: 'function',
    function: {
      name: MANAGE_MCP,
      description: [
        'Add, change, remove, enable or disable the MCP tool servers in mcp.json. The user is',
        'asked to approve every change, so say what you are about to do and why in your reply.',
        'Use "list" first to see what is configured and whether each server is connected.',
        '',
        'A server is either local ("command", optional "args", "env", "cwd": a program this',
        'machine runs) or remote ("url", optional "headers", "transport": "sse" for SSE servers,',
        'default Streamable HTTP). Never give both.',
        '',
        'Secrets. You can write API keys but never read them back: results show header and env',
        'NAMES only. To change one header, pass just that header; the others are kept. Pass null',
        'to remove one. Prefer "${NAME}" over a literal key, e.g. {"Authorization": "Bearer',
        '${GITHUB_TOKEN}"}: TinyWebUI fills it in from its own environment, so the key is never',
        'stored in mcp.json or in this chat. Use a literal value only if the user gave you the key',
        'in this conversation, and never repeat a key in your replies.',
        '',
        'Changes are saved immediately but take effect when your reply is finished: a new',
        "server's tools are available from the user's next message, so tell them that rather",
        'than trying to call them now. Only add servers the user asked for, and only commands',
        'they named or clearly approved: a local server runs as a program on their machine.',
        '',
        'Actions and what each needs:',
        '- list: nothing.',
        '- add: name, plus command or url (and optionally args, env, cwd, headers, transport).',
        '- update: name, plus only the fields to change. args replaces the whole list. env and',
        '  headers merge by name. You cannot switch a server between local and remote; remove and add.',
        '- remove: name. Permanent.',
        '- enable / disable: name. Disabling keeps the entry and drops the connection.'
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'add', 'update', 'remove', 'enable', 'disable'] },
          name: { type: 'string', description: 'Server name: letters, digits, "-" and "_", up to 32. It prefixes the names of its tools.' },
          command: { type: 'string', description: 'Local server: the program to run, e.g. "npx" or "uvx".' },
          args: { type: 'array', items: { type: 'string' }, description: 'Local server: its arguments.' },
          cwd: { type: 'string', description: 'Local server: working directory.' },
          env: { type: 'object', additionalProperties: { type: ['string', 'null'] }, description: 'Local server: environment variables to set. null removes one.' },
          url: { type: 'string', description: 'Remote server: its http(s) URL.' },
          transport: { type: 'string', enum: ['http', 'sse'], description: 'Remote server: "sse" only for SSE servers; the default is Streamable HTTP.' },
          headers: { type: 'object', additionalProperties: { type: ['string', 'null'] }, description: 'Remote server: request headers, e.g. an Authorization header. null removes one.' }
        },
        required: ['action']
      }
    }
  };
}

/* ---------- what the model is allowed to see ---------- */

const shown = (v) => (REF_ONLY.test(String(v)) ? String(v) : HIDDEN);
const maskMap = (obj) => obj && Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, shown(v)]));

/** Arguments, with the value of anything that looks like a credential flag hidden. */
function maskArgs(args = []) {
  let afterSecretFlag = false;
  return args.map((a) => {
    const s = String(a);
    const inline = /^(--?[\w-]+)=([\s\S]*)$/.exec(s);
    if (inline) return SECRETISH.test(inline[1]) && !REF_ONLY.test(inline[2]) ? `${inline[1]}=${HIDDEN}` : s;
    const isFlag = /^--?[\w-]+$/.test(s);
    const hide = afterSecretFlag && !isFlag && !REF_ONLY.test(s);
    afterSecretFlag = isFlag && SECRETISH.test(s);
    return hide ? HIDDEN : s;
  });
}

/** A URL without credentials: userinfo, query values and token-length path segments are hidden. */
function maskUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return HIDDEN; }
  const path = u.pathname.split('/').map((seg) => (seg.length >= 20 && !REF_ONLY.test(decodeURIComponent(seg)) ? HIDDEN : seg)).join('/');
  const query = [...u.searchParams].map(([k, v]) => `${k}=${REF_ONLY.test(v) ? v : HIDDEN}`).join('&');
  return `${u.protocol}//${u.host}${path}${query ? `?${query}` : ''}`;
}

/** Every literal secret value in a spec, so an error message that quotes one can be cleaned. */
function literalSecrets(spec) {
  const values = [...Object.values(spec.headers || {}), ...Object.values(spec.env || {})].map(String);
  try {
    const u = new URL(spec.url);
    if (u.password) values.push(u.password);
    values.push(...[...u.searchParams.values()], ...u.pathname.split('/').filter((s) => s.length >= 20));
  } catch { /* a local server, or a URL that does not parse */ }
  return values.filter((v) => v.length >= 6 && !REF_ONLY.test(v));
}

const scrub = (text, spec) => literalSecrets(spec).reduce((t, secret) => t.split(secret).join(HIDDEN), String(text));

function describe(name, spec, live) {
  const out = { name, type: spec.command ? 'local' : 'remote', enabled: !spec.disabled };
  if (spec.command) {
    out.command = spec.command;
    if (spec.args?.length) out.args = maskArgs(spec.args);
    if (spec.cwd) out.cwd = spec.cwd;
    if (spec.env && Object.keys(spec.env).length) out.env = maskMap(spec.env);
  } else {
    out.url = maskUrl(spec.url);
    out.transport = spec.transport === 'sse' ? 'sse' : 'http';
    if (spec.headers && Object.keys(spec.headers).length) out.headers = maskMap(spec.headers);
  }
  if (live) {
    out.status = live.status;
    if (live.error) out.error = scrub(live.error, spec);
    out.tools = live.tools;
  }
  return out;
}

/* ---------- checking what the model wrote ---------- */

function plainMap(value, what, nameRule) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`"${what}" must be an object of name: value`);
  const entries = Object.entries(value);
  if (entries.length > MAX_ENTRIES) throw new Error(`"${what}" can hold at most ${MAX_ENTRIES} entries`);
  for (const [k, v] of entries) {
    if (!nameRule.test(k)) throw new Error(`"${what}" has an invalid name`);
    if (v === null) continue;
    if (typeof v !== 'string' || v.length > MAX_VALUE || /[\r\n]/.test(v)) throw new Error(`"${what}.${k}" must be a single-line string, or null to remove it`);
  }
  return value;
}

/** Applies a name -> value | null patch to the current map; an empty result is dropped. */
function patched(current, patch) {
  if (patch === undefined) return current;
  const out = { ...(current || {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k]; else out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

function checkUrl(raw) {
  if (typeof raw !== 'string' || !raw) throw new Error('"url" must be a string');
  let u;
  try { u = new URL(raw); } catch { throw new Error('"url" is not a valid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('"url" must start with http:// or https://');
  return u;
}

const LOCAL_ONLY = ['command', 'args', 'cwd', 'env'];
const REMOTE_ONLY = ['url', 'transport', 'headers'];

function rejectOther(args, fields, kind) {
  const given = fields.filter((f) => args[f] !== undefined);
  if (given.length) throw new Error(`${given.map((f) => `"${f}"`).join(', ')} cannot be used with a ${kind} server`);
}

/** Folds the call's fields into a server entry, validating as it goes. `base` is the current entry for an update. */
function build(args, base) {
  const local = base ? Boolean(base.command) : Boolean(args.command);
  if (!base && Boolean(args.command) === Boolean(args.url)) {
    throw new Error('give either "command" (a local program) or "url" (a remote server), not both and not neither');
  }
  const spec = { ...(base || {}) };
  if (local) {
    rejectOther(args, REMOTE_ONLY, 'local');
    if (args.command !== undefined) {
      if (typeof args.command !== 'string' || !args.command.trim()) throw new Error('"command" must be a non-empty string');
      spec.command = args.command.trim();
    }
    if (args.args !== undefined) {
      if (!Array.isArray(args.args) || args.args.length > MAX_ARGS || args.args.some((a) => typeof a !== 'string' || a.length > MAX_VALUE)) {
        throw new Error(`"args" must be a list of at most ${MAX_ARGS} strings`);
      }
      spec.args = args.args;
    }
    if (args.cwd !== undefined) {
      if (typeof args.cwd !== 'string') throw new Error('"cwd" must be a string');
      spec.cwd = args.cwd;
    }
    const env = patched(spec.env, plainMap(args.env, 'env', ENV_NAME));
    if (env) spec.env = env; else delete spec.env;
  } else {
    rejectOther(args, LOCAL_ONLY, 'remote');
    if (args.url !== undefined) { checkUrl(args.url); spec.url = args.url; }
    if (args.transport !== undefined) {
      if (!['http', 'sse'].includes(args.transport)) throw new Error('"transport" must be "http" or "sse"');
      if (args.transport === 'sse') spec.transport = 'sse'; else delete spec.transport;
    }
    const headers = patched(spec.headers, plainMap(args.headers, 'headers', HEADER_NAME));
    if (headers) spec.headers = headers; else delete spec.headers;
  }
  return spec;
}

/** Notes worth telling the model about a spec it just wrote. */
function notes(spec, wrote) {
  const out = {};
  const plain = Object.entries({ ...(spec.headers || {}), ...(spec.env || {}) })
    .filter(([k, v]) => wrote.includes(k) && SECRETISH.test(k) && !REF_ONLY.test(String(v)) && !String(v).includes('${'))
    .map(([k]) => k);
  if (plain.length) {
    out.hint = `${plain.join(', ')} is stored as plain text in mcp.json. To keep a key out of the file, set an environment`
      + ' variable for TinyWebUI and use "${NAME}" as the value instead.';
  }
  if (spec.url && spec.headers && new URL(spec.url).protocol === 'http:' && !/^(localhost|127\.|\[::1\])/.test(new URL(spec.url).hostname)) {
    out.warning = 'This URL is plain http to another machine, so its headers travel unencrypted. Prefer https.';
  }
  return out;
}

/**
 * `mcp`: { servers(), save(servers, change), locked(), status(), check(spec) }.
 * `servers()` throws when mcp.json is not valid JSON, so a broken file is
 * never overwritten with one new entry.
 */
export function callManageMcp(args, { mcp, chatId } = {}) {
  if (!mcp) return 'Error: this tool is not available here.';
  const { action } = args || {};
  const known = ['list', 'add', 'update', 'remove', 'enable', 'disable'];
  if (!known.includes(action)) return `Error: action must be one of ${known.join(', ')}.`;

  let servers;
  try { servers = mcp.servers(); } catch (err) { return `Error: ${err.message}`; }
  const live = mcp.status();

  if (action === 'list') {
    return JSON.stringify({
      editable: !mcp.locked(),
      servers: Object.keys(servers).sort().map((n) => describe(n, servers[n], live[n]))
    });
  }
  if (mcp.locked()) {
    return 'Error: the MCP servers are locked in this deployment (set in code, or frozen), so they cannot be changed from here. Tell the user to edit mcp.json themselves.';
  }

  const name = args.name;
  if (typeof name !== 'string' || !NAME.test(name)) return 'Error: "name" must be 1-32 letters, digits, "-" or "_".';
  const exists = Object.hasOwn(servers, name);

  try {
    let wrote = [];
    if (action === 'add') {
      if (exists) return `Error: a server named "${name}" already exists. Use update to change it.`;
      if (Object.keys(servers).length >= MAX_SERVERS) return `Error: at most ${MAX_SERVERS} servers can be configured.`;
      servers[name] = build(args, null);
      wrote = [...Object.keys(args.headers || {}), ...Object.keys(args.env || {})];
    } else if (!exists) {
      return `Error: no server named "${name}". Use list to see what is configured.`;
    } else if (action === 'update') {
      const fields = [...LOCAL_ONLY, ...REMOTE_ONLY, 'args'].filter((f) => args[f] !== undefined);
      if (!fields.length) return 'Error: update needs at least one field to change.';
      servers[name] = build(args, servers[name]);
      wrote = [...Object.keys(args.headers || {}), ...Object.keys(args.env || {})];
    } else if (action === 'remove') {
      delete servers[name];
    } else {
      const on = action === 'enable';
      if (on) delete servers[name].disabled; else servers[name].disabled = true;
    }

    mcp.save(servers, { by: `assistant (chat ${chatId ?? '?'})`, change: { action, name } });

    const result = { saved: true, action, name, takes_effect: 'when this reply is finished; new tools are available from the next message' };
    if (action !== 'remove') {
      result.server = describe(name, servers[name]);
      Object.assign(result, notes(servers[name], wrote));
      const missing = servers[name].command && !servers[name].disabled ? mcp.check?.(servers[name]) : null;
      if (missing) result.warning = missing;
    }
    return JSON.stringify(result);
  } catch (err) {
    // Validation messages name fields, never values; save errors name the file.
    return `Error: ${err.message}`;
  }
}
