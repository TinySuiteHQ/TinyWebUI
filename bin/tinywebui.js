#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

// `--config <path>` (or `validate <path>`) points every command at a config
// file, JS or JSON, exactly like $TINYWEBUI_CONFIG does.
const configArg = flag('config') ?? (args[0] === 'validate' && args[1] && !args[1].startsWith('--') ? args[1] : undefined);
if (configArg) process.env.TINYWEBUI_CONFIG = resolve(configArg);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`tinywebui [start] [--port 7777] [--host 127.0.0.1] [--config path]
tinywebui set-password     create or change the owner password
tinywebui validate [path]  check the config files; prints the fingerprint, exits 1 on problems
tinywebui migrate [--check]
                           bring the database to the current schema (--check: exit 1 if behind)
tinywebui doctor           check config, database, model endpoint and MCP servers
tinywebui config show      same as effective
tinywebui models pull <fast|balanced|quality|multilingual> [--dir path]
                           fetch an embedding bundle for hybrid retrieval
tinywebui models ensure    pull the configured model only if missing (npm start runs this)
tinywebui models verify    load the configured embedding model the way startup does
tinywebui effective [--role user|admin]
                           what is in effect and how each setting can change
tinywebui fingerprint      the config's fingerprint (secrets never included)
tinywebui users list       users and the decisions pinned in the files
tinywebui users set <id> [--role admin|user] [--status pending|approved|disabled] [--clear]
                           record a decision in config.json (a running server reloads it)
tinywebui schema           JSON Schema for the config file

Config comes from ./tinywebui.config.js if it exists, then
./tinywebui.config.json ($TINYWEBUI_CONFIG may point at either), and MCP
servers from mcp.json next to it (or $TINYWEBUI_MCP).

tinywebui.config.js exports the options start() takes, as an object or an
(async) function returning one:

  export default {
    config: { model: 'anthropic/claude-sonnet-5', apiKey: process.env.KEY },
    mcpServers: { files: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] } },
  };

Keys under "config" win over the JSON file and are locked in the settings
panel. See README for the rest.
`);
  process.exit(0);
}

// Resolve the JS config before src/config/config.js is imported: that module fixes
// its JSON path at load time from $TINYWEBUI_CONFIG, so a .js path there has
// to be swapped for the JSON file beside it first.
const envPath = process.env.TINYWEBUI_CONFIG && resolve(process.env.TINYWEBUI_CONFIG);
let jsPath = null;
if (envPath && /\.[cm]?js$/.test(envPath)) {
  jsPath = envPath;
  process.env.TINYWEBUI_CONFIG = resolve(dirname(envPath), 'tinywebui.config.json');
} else if (!envPath) {
  for (const name of ['tinywebui.config.js', 'tinywebui.config.mjs']) {
    const p = resolve(process.cwd(), name);
    if (existsSync(p)) { jsPath = p; break; }
  }
}

try {
  let opts = {};
  if (jsPath && !existsSync(jsPath)) throw new Error(`config file not found: ${jsPath}`);
  if (jsPath) {
    const mod = await import(pathToFileURL(jsPath).href);
    const exported = mod.default ?? mod;
    opts = (typeof exported === 'function' ? await exported() : exported) || {};
    // stderr, so a command's stdout stays pure JSON for scripts.
    console.error(`[tinywebui] options: ${jsPath}`);
  }
  if (args[0] === 'set-password') {
    const { setPassword } = await import('../src/set-password.js');
    await setPassword(opts);
    process.exit(0);
  }
  const COMMANDS = ['validate', 'effective', 'fingerprint', 'users', 'schema', 'migrate', 'doctor', 'config', 'models'];
  if (COMMANDS.includes(args[0])) {
    const { runCli } = await import('../src/cli.js');
    process.exit(await runCli(args[0], args.slice(1), opts));
  }
  if (args[0] && !args[0].startsWith('--') && args[0] !== 'start') {
    console.error(`[tinywebui] unknown command "${args[0]}" (see --help)`);
    process.exit(1);
  }
  const { createConfigSource } = await import('../src/config/config.js');
  const initial = createConfigSource(opts).load({ persistSecret: false });
  if (initial.authMode === 'single' && !initial.authPassword && !process.env.TINYWEBUI_PASSWORD) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error('owner password required: run `tinywebui set-password` in a terminal, or set TINYWEBUI_PASSWORD before starting');
    }
    const { setPassword } = await import('../src/set-password.js');
    console.log('[tinywebui] Set an owner password before the first start.');
    await setPassword(opts);
  }
  const { start } = await import('../src/server.js');
  // Command-line flags beat the file; the file beats the built-in defaults.
  await start({
    ...opts,
    port: Number(flag('port', opts.port ?? process.env.PORT ?? 7777)),
    host: flag('host', opts.host ?? '127.0.0.1'),
  });
} catch (err) {
  console.error(`[tinywebui] ${err.message}`);
  process.exit(1);
}
