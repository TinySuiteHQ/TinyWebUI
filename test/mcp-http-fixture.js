// A real streamable-HTTP MCP server on loopback for hub tests: every request
// is recorded with the identity header it carried and the session it was on,
// so a test can check what actually went over the wire. Not a test file.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

/**
 * `header` is the identity header to record (lower case). `setup(server)` may
 * register more tools or resources on each session's McpServer.
 * Returns { url, calls, requests, sessions, dropSession(id), close() }.
 */
export async function startMcpHttpServer({ header = 'x-user', setup } = {}) {
  const calls = [];     // { tool, identity, sessionId }
  const requests = [];  // { method, identity, sessionId }
  const sessions = new Map(); // id -> transport

  const build = () => {
    const server = new McpServer({ name: 'fixture', version: '1.0.0' });
    server.registerTool('whoami', {
      description: 'Returns the identity this call arrived with.',
      annotations: { readOnlyHint: true, idempotentHint: true }
    }, async (extra) => {
      const identity = extra.requestInfo?.headers?.[header] ?? null;
      calls.push({ tool: 'whoami', identity, sessionId: extra.sessionId });
      // Long enough for concurrent calls from different users to overlap.
      await new Promise((r) => setTimeout(r, 5));
      return { content: [{ type: 'text', text: `identity=${identity}` }] };
    });
    setup?.(server, { calls, header });
    return server;
  };

  const http = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = body ? JSON.parse(body) : undefined;
    const sessionId = req.headers['mcp-session-id'];
    requests.push({ method: parsed?.method ?? req.method, identity: req.headers[header] ?? null, sessionId: sessionId ?? null });
    let transport = sessionId ? sessions.get(sessionId) : undefined;
    if (!transport) {
      if (sessionId) { res.writeHead(404).end(); return; }
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => { sessions.set(id, transport); }
      });
      transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
      await build().connect(transport);
    }
    await transport.handleRequest(req, res, parsed);
  });
  const port = await new Promise((r) => http.listen(0, '127.0.0.1', () => r(http.address().port)));

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    calls,
    requests,
    sessions,
    /** Forgets a session, as a restarted server would: its next request gets 404. */
    dropSession(id) { const t = sessions.get(id); sessions.delete(id); return t?.close(); },
    async close() {
      for (const t of sessions.values()) await t.close().catch(() => {});
      http.closeAllConnections?.();
      await new Promise((r) => http.close(r));
    }
  };
}
