#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

if (args.includes('--help') || args.includes('-h')) {
  console.log(`tinywebui [--port 7777] [--host 127.0.0.1]

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

// Resolve the JS config before src/config.js is imported: that module fixes
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
  if (jsPath) {
    const mod = await import(pathToFileURL(jsPath).href);
    const exported = mod.default ?? mod;
    opts = (typeof exported === 'function' ? await exported() : exported) || {};
    console.log(`[tinywebui] options: ${jsPath}`);
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
