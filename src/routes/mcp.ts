import { json, readJson, UPLOAD_LIMIT } from '../http.ts';
import { LockedError } from '../config/config.ts';
import { fingerprint } from '../access/policy.ts';
import { actor } from '../access/auth_gate.ts';
import { toolList } from './settings.ts';
import { logger } from '../log.ts';
import type { ServerResponse } from 'node:http';
import type { Auth } from '../access/auth_gate.ts';
import { FEATURE } from '../../public/shared/features.js';
import type { Route, RouteDeps } from './types.ts';

const log = logger('mcp');

export function mcpRoutes({ auditMcp, config, hub, source, swapHub, toolsView }: Pick<RouteDeps, 'auditMcp' | 'config' | 'hub' | 'source' | 'swapHub' | 'toolsView'>): Route[] {

  /** Writes mcp.json (audited), then reconnects. A locked or invalid file is the caller's error. */
  const saveAndReconnect = async (res: ServerResponse, text: string, auth: Auth) => {
    let servers;
    try {
      const before = fingerprint(config(), source.loadMcpServers());
      servers = source.saveMcpFile(text);
      auditMcp(actor(auth), before);
    } catch (err) {
      json(res, err instanceof LockedError ? 409 : 400, { error: err.message });
      return false;
    }
    await swapHub(servers);
    log.info(`reloaded: ${hub().tools.length} tool(s)`);
    return true;
  };

  return [
    // mcp.json can hold server credentials (env, headers): admins only.
    { method: 'GET', path: /^\/api\/mcp$/, feature: FEATURE.MCP, handle: ({ res }) =>
      json(res, 200, { path: source.mcpPath(), text: source.readMcpFile(), locked: source.mcpLocked }) },

    { method: 'POST', path: /^\/api\/mcp$/, feature: FEATURE.MCP, handle: async ({ req, res, auth }) => {
      const { text } = await readJson(req, UPLOAD_LIMIT);
      if (typeof text !== 'string') return json(res, 400, { error: 'text must be the contents of mcp.json' });
      if (!await saveAndReconnect(res, text, auth)) return undefined;
      return json(res, 200, { tools: toolList(hub()), mcpErrors: hub().errors });
    } },

    // Disabling a server tears its connection down rather than filtering its
    // tools out client-side: an unwanted server is one fewer child process or
    // open connection, not just one the model happens not to be offered.
    { method: 'POST', path: /^\/api\/mcp\/servers\/([^/]+)\/toggle$/, feature: FEATURE.MCP, handle: async ({ req, res, auth, params: [rawName] }) => {
      const name = decodeURIComponent(rawName);
      const { disabled } = await readJson(req);
      let servers;
      try {
        const parsed = JSON.parse(source.readMcpFile());
        servers = parsed.mcpServers || parsed;
      } catch (err) {
        return json(res, 500, { error: `mcp.json is not valid JSON: ${err.message}` });
      }
      if (!servers[name]) return json(res, 404, { error: `no such server "${name}"` });
      servers[name] = { ...servers[name], disabled: Boolean(disabled) };
      if (!await saveAndReconnect(res, JSON.stringify({ mcpServers: servers }, null, 2), auth)) return undefined;
      return json(res, 200, { ...hub().inventory(config().disabledTools), disabledTools: config().disabledTools || [] });
    } },

    // Tries a server that failed to connect again, now, rather than at its
    // next automatic attempt. It changes no configuration, so it is the tools
    // panel's to offer, and it works where mcp.json is set in code.
    { method: 'POST', path: /^\/api\/mcp\/servers\/([^/]+)\/retry$/, feature: FEATURE.TOOLS, handle: async ({ res, params: [rawName] }) => {
      const name = decodeURIComponent(rawName);
      if (!hub().servers[name]) return json(res, 404, { error: `no such server "${name}"` });
      await hub().retry(name);
      return json(res, 200, toolsView());
    } }
  ];
}
