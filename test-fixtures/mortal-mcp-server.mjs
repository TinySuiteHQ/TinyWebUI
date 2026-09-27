// A tiny MCP server that can be killed on demand, for exercising reconnects.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({ name: 'mortal', version: '0.0.1' });

server.registerTool(
  'pid',
  { description: 'Returns the server process id.', inputSchema: {},
    annotations: { readOnlyHint: true, idempotentHint: true } },
  async () => ({ content: [{ type: 'text', text: String(process.pid) }] })
);

server.registerTool(
  'die',
  { description: 'Exits the server mid-call.', inputSchema: {} },
  async () => { process.exit(1); }
);

server.registerTool(
  'die_readonly',
  { description: 'Exits mid-call, but declares itself safe to repeat.', inputSchema: {},
    annotations: { readOnlyHint: true, idempotentHint: true } },
  async () => {
    // Dies only on the first process: a restarted server answers.
    if (!process.env.MORTAL_SURVIVED) { process.exit(1); }
    return { content: [{ type: 'text', text: 'ok' }] };
  }
);

await server.connect(new StdioServerTransport());
