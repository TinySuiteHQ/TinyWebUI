// A minimal real MCP server, spoken over stdio, for exercising the hub and
// the settings-panel routes end to end -- not a mock of the protocol, an
// actual (tiny) implementation of it.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'toy', version: '0.0.1' });

server.registerTool(
  'echo',
  { description: 'Echoes back what it is given.', inputSchema: { text: z.string() } },
  async ({ text }) => ({ content: [{ type: 'text', text }] })
);

server.registerTool(
  'boom',
  { description: 'Always fails, to exercise the error path.', inputSchema: {} },
  async () => { throw new Error('boom'); }
);

await server.connect(new StdioServerTransport());
