import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

const SEP = '__';

/** One row of the inventory: what the settings UI needs to draw and toggle a tool. */
function toRow(t, disabled) {
  return { name: t.function.name, description: t.function.description, disabled: disabled.has(t.function.name) };
}

function transportFor(name, spec) {
  if (spec.command) {
    return new StdioClientTransport({
      command: spec.command,
      args: spec.args || [],
      env: { ...process.env, ...(spec.env || {}) },
      cwd: spec.cwd,
      // Piped rather than inherited so we can label it and, more importantly,
      // drop the shutdown noise -- a stdio server killed by Ctrl-C prints a full
      // KeyboardInterrupt traceback that is not a failure and not worth showing.
      stderr: 'pipe'
    });
  }
  if (spec.url) {
    const opts = spec.headers ? { requestInit: { headers: spec.headers } } : undefined;
    const url = new URL(spec.url);
    return spec.transport === 'sse'
      ? new SSEClientTransport(url, opts)
      : new StreamableHTTPClientTransport(url, opts);
  }
  throw new Error(`mcpServers.${name}: needs either "command" (stdio) or "url" (http)`);
}

/**
 * Connects every configured MCP server and exposes their tools as one flat,
 * stably ordered list of OpenAI-style function tools.
 */
export class McpHub {
  constructor(servers = {}) {
    this.servers = servers;
    this.closing = false;
    this.clients = new Map();
    this.tools = [];       // OpenAI tool defs, sorted for a stable cache prefix
    this.routes = new Map(); // flat tool name -> { server, tool }
    this.locals = new Map(); // flat tool name -> handler, for tools we implement
    this.errors = [];
  }

  /**
   * Adds a tool this process implements rather than one an MCP server exposes.
   * Registered after connect() so locals always land at the end of the block,
   * keeping the tool list byte-identical between runs.
   */
  registerLocal(def, handler) {
    this.locals.set(def.function.name, handler);
    this.tools.push(def);
    return this;
  }

  async connect() {
    // Sorted so the tool block handed to the model is byte-identical run to run.
    for (const name of Object.keys(this.servers).sort()) {
      const spec = this.servers[name];
      if (spec.disabled) continue;
      try {
        const client = new Client(
          { name: 'tinywebui', version: '0.1.0' },
          { capabilities: {} }
        );
        const transport = transportFor(name, spec);
        await client.connect(transport);
        this.pipeStderr(name, transport.stderr);
        this.clients.set(name, client);
        const { tools } = await client.listTools();
        for (const t of tools.sort((a, b) => a.name.localeCompare(b.name))) {
          const flat = `${name}${SEP}${t.name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
          this.routes.set(flat, { server: name, tool: t.name });
          this.tools.push({
            type: 'function',
            function: {
              name: flat,
              description: t.description || '',
              parameters: t.inputSchema || { type: 'object', properties: {} }
            }
          });
        }
      } catch (err) {
        this.errors.push(`${name}: ${err.message}`);
        console.error(`[mcp] ${name} failed to connect: ${err.message}`);
      }
    }
    return this;
  }

  /** Labels a child's stderr, and goes quiet once we are tearing it down. */
  pipeStderr(name, stream) {
    if (!stream) return;
    let buf = '';
    stream.on('data', (chunk) => {
      if (this.closing) return;
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (line.trim() && !this.closing) console.error(`[${name}] ${line}`);
      }
    });
    stream.on('error', () => { /* the child is going away; nothing to report */ });
  }

  /**
   * The tools actually sent to the model: everything the hub has, minus what
   * the settings UI has switched off. The tool block still has to be stable
   * for the cache to hold, so this filters `tools` in place rather than
   * rebuilding or reordering it -- turning a tool back on or off is the one
   * thing that is allowed to cost a cache miss, and only that turn's.
   */
  activeTools(disabledNames = []) {
    if (!disabledNames?.length) return this.tools;
    const disabled = new Set(disabledNames);
    return this.tools.filter((t) => !disabled.has(t.function.name));
  }

  /**
   * A structured view for the settings panel: which tools are ours, which came
   * from which server, and that server's health -- connected, disabled, or
   * failed to connect and why. Disabling here is advisory only, a flag drawn
   * from `disabledNames`; `activeTools` is what actually enforces it.
   */
  inventory(disabledNames = []) {
    const disabled = new Set(disabledNames);
    const internal = this.tools
      .filter((t) => this.locals.has(t.function.name))
      .map((t) => toRow(t, disabled));

    const servers = Object.keys(this.servers).sort().map((name) => {
      const spec = this.servers[name];
      const status = spec.disabled ? 'disabled' : this.clients.has(name) ? 'ok' : 'error';
      // Errors are recorded as "name: message"; the name is stripped back off.
      const error = this.errors.find((e) => e.startsWith(`${name}: `))?.slice(name.length + 2) ?? null;
      return { name, status, error, tools: [] };
    });
    const byName = new Map(servers.map((row) => [row.name, row]));
    for (const t of this.tools) {
      const route = this.routes.get(t.function.name);
      if (route) byName.get(route.server)?.tools.push(toRow(t, disabled));
    }
    return { internal, servers };
  }

  /** Returns a string, because that is all a tool result message can carry. */
  async call(flatName, args, ctx) {
    const local = this.locals.get(flatName);
    if (local) {
      try { return String(await local(args || {}, ctx || {})); }
      catch (err) { return `Error calling ${flatName}: ${err.message}`; }
    }
    const route = this.routes.get(flatName);
    if (!route) return `Error: unknown tool "${flatName}"`;
    const client = this.clients.get(route.server);
    try {
      const res = await client.callTool({ name: route.tool, arguments: args || {} });
      const text = (res.content || [])
        .map((c) => {
          if (c.type === 'text') return c.text;
          if (c.type === 'resource') return c.resource?.text ?? JSON.stringify(c.resource);
          return `[${c.type}]`;
        })
        .join('\n');
      return res.isError ? `Error: ${text}` : text || '(no output)';
    } catch (err) {
      return `Error calling ${flatName}: ${err.message}`;
    }
  }

  async close() {
    this.closing = true;
    for (const client of this.clients.values()) {
      try { await client.close(); } catch { /* shutting down anyway */ }
    }
  }
}
