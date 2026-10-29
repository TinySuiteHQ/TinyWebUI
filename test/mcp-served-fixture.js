// A stand-in for a TinySuite server started with `serve` (src/mcp_serve.ts):
// run as its own process, it listens where MCP_HOST/MCP_PORT say, refuses any
// request without the proxy token, and reports what each call arrived with.
// Not a test file: `node --test` also loads it, and then it does nothing.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const { MCP_TRANSPORT, MCP_HOST, MCP_PORT, FX_PROXY_TOKEN, FX_MANAGEMENT_TOKEN } = process.env;
const launched = MCP_TRANSPORT === 'streamable-http' && Boolean(MCP_PORT);

const seen = (headers) => JSON.stringify({
  user: headers['x-fx-user'] ?? null,
  management: Boolean(FX_MANAGEMENT_TOKEN) && headers.authorization === `Bearer ${FX_MANAGEMENT_TOKEN}`,
  secret: process.env.FX_SECRET ?? null,
  data: process.env.FX_DATA ?? null,
  pid: process.pid
});

const sessions = new Map();
const build = () => {
  const server = new McpServer({ name: 'served-fixture', version: '1.0.0' });
  server.registerTool('whoami', { annotations: { readOnlyHint: true } },
    async (extra) => ({ content: [{ type: 'text', text: seen(extra.requestInfo?.headers || {}) }] }));
  server.registerTool('crash', {}, async () => {
    setTimeout(() => process.exit(3), 20);
    return { content: [{ type: 'text', text: 'going down' }] };
  });
  server.registerResource('who', 'fx://who', { mimeType: 'application/json' },
    async (uri, extra) => ({ contents: [{ uri: uri.href, text: seen(extra.requestInfo?.headers || {}) }] }));
  return server;
};

const http = createServer(async (req, res) => {
  if (req.headers['x-fx-proxy-token'] !== FX_PROXY_TOKEN) { res.writeHead(401).end('not the proxy'); return; }
  let body = '';
  for await (const chunk of req) body += chunk;
  const parsed = body ? JSON.parse(body) : undefined;
  const sessionId = req.headers['mcp-session-id'];
  let transport = sessionId ? sessions.get(sessionId) : undefined;
  if (!transport) {
    if (sessionId) { res.writeHead(404).end(); return; }
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => { sessions.set(id, transport); }
    });
    await build().connect(transport);
  }
  await transport.handleRequest(req, res, parsed);
});
if (launched) http.listen(Number(MCP_PORT), MCP_HOST || '127.0.0.1', () => process.stderr.write(`listening on ${MCP_PORT}\n`));
