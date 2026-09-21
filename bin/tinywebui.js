#!/usr/bin/env node
import { start } from '../src/server.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

if (args.includes('--help') || args.includes('-h')) {
  console.log(`tinywebui [--port 7777] [--host 127.0.0.1]

Config is read from ./tinywebui.config.json (or $TINYWEBUI_CONFIG):

  {
    "baseUrl": "https://openrouter.ai/api/v1",
    "apiKey": "sk-or-...",
    "model": "anthropic/claude-sonnet-5",
    "systemPrompt": "You are a helpful assistant.",
    "cache": true,
    "mcpServers": {
      "files": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
      "remote": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ..." } }
    }
  }
`);
  process.exit(0);
}

start({ port: Number(flag('port', process.env.PORT || 7777)), host: flag('host', '127.0.0.1') })
  .catch((err) => { console.error(`[tinywebui] ${err.message}`); process.exit(1); });
