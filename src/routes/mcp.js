import { json, readJson, UPLOAD_LIMIT } from '../http.js';
import { LockedError } from '../config/config.js';
import { fingerprint } from '../access/policy.js';
import { actor } from '../access/auth_gate.js';
import { toolList } from './settings.js';

export function mcpRoutes(app) {
  const { source } = app;

  /** Writes mcp.json (audited), then reconnects. A locked or invalid file is the caller's error. */
  const saveAndReconnect = async (res, text, auth) => {
    let servers;
    try {
      const before = fingerprint(app.cfg, source.loadMcpServers());
      servers = source.saveMcpFile(text);
      app.auditMcp(actor(auth), before);
    } catch (err) {
      json(res, err instanceof LockedError ? 409 : 400, { error: err.message });
      return false;
    }
    await app.swapHub(servers);
    console.log(`[tinywebui] mcp reloaded: ${app.hub.tools.length} tool(s)`);
    return true;
  };

  return [
    // mcp.json can hold server credentials (env, headers): admins only.
    { method: 'GET', path: /^\/api\/mcp$/, feature: 'mcp', handle: ({ res }) =>
      json(res, 200, { path: source.mcpPath(), text: source.readMcpFile(), locked: source.mcpLocked }) },

    { method: 'POST', path: /^\/api\/mcp$/, feature: 'mcp', handle: async ({ req, res, auth }) => {
      const { text } = await readJson(req, UPLOAD_LIMIT);
      if (!await saveAndReconnect(res, text, auth)) return undefined;
      return json(res, 200, { tools: toolList(app.hub), mcpErrors: app.hub.errors });
    } },

    // Disabling a server tears its connection down rather than filtering its
    // tools out client-side: an unwanted server is one fewer child process or
    // open connection, not just one the model happens not to be offered.
    { method: 'POST', path: /^\/api\/mcp\/servers\/([^/]+)\/toggle$/, feature: 'mcp', handle: async ({ req, res, auth, params: [rawName] }) => {
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
      return json(res, 200, { ...app.hub.inventory(app.cfg.disabledTools), disabledTools: app.cfg.disabledTools || [] });
    } }
  ];
}
