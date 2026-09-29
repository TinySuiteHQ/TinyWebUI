import { json, readJson } from '../http.js';
import { isClosed, enabledEntries, publicEntry } from '../models.js';
import { modelsFor } from '../policy.js';
import { audit } from '../auth.js';
import { setOverride } from '../approval.js';
import { actor } from '../auth_gate.js';

export const toolList = (hub) => hub.tools.map((t) => ({
  name: t.function.name,
  description: t.function.description,
  parameters: t.function.parameters
}));

export function settingsRoutes(app) {
  // The provider's model list, cached per endpoint for a few minutes:
  // OpenRouter's list is large and the picker is opened far more often than
  // the catalogue changes.
  let modelCache = null;
  const listModels = async () => {
    const { cfg } = app;
    const key = `${cfg.baseUrl}|${Boolean(cfg.apiKey)}`;
    if (modelCache?.key === key && Date.now() - modelCache.at < 5 * 60_000) return modelCache.value;
    let value;
    try {
      const r = await fetch(`${cfg.baseUrl}/models`, {
        headers: cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {},
        signal: AbortSignal.timeout(8000)
      });
      if (!r.ok) throw new Error(`${r.status} from ${cfg.baseUrl}/models`);
      const body = await r.json();
      const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
      const models = rows
        .map((m) => ({ id: m.id || m.name, name: m.name && m.name !== m.id ? m.name : null }))
        .filter((m) => typeof m.id === 'string' && m.id)
        .sort((a, b) => a.id.localeCompare(b.id));
      value = { supported: models.length > 0, models };
    } catch (err) {
      value = { supported: false, models: [], error: err.message };
    }
    modelCache = { key, at: Date.now(), value };
    return value;
  };

  return [
    { method: 'GET', path: /^\/api\/config$/, feature: null, handle: ({ res, auth }) => json(res, 200, {
      ...app.configFor(auth),
      tools: toolList(app.hub),
      mcpErrors: app.hub.errors
    }) },

    { method: 'POST', path: /^\/api\/config$/, feature: 'settings', handle: async ({ req, res, auth }) => {
      app.cfg = app.saveConfig(await readJson(req), actor(auth));
      audit('admin.config_changed', { by: auth.userId ?? null });
      return json(res, 200, app.configFor(auth));
    } },

    // The provider's own model list, for the composer's model picker. Not
    // every OpenAI-compatible endpoint serves /models, so a failure is an
    // answer too: the picker falls back to typing an id.
    { method: 'GET', path: /^\/api\/models$/, feature: 'model-picker', handle: async ({ res, auth }) => {
      const { cfg } = app;
      const allowed = modelsFor(cfg, auth.role);
      // A catalog is the whole list: its labels, never the provider's ids.
      if (isClosed(cfg)) {
        const entries = enabledEntries(cfg).filter((e) => allowed === '*' || allowed.includes(e.id));
        return json(res, 200, { supported: true, restricted: true, catalog: true, models: entries.map(publicEntry) });
      }
      const all = await listModels();
      if (allowed === '*') return json(res, 200, all);
      // A fixed catalog: only those ids, named from the provider list when
      // it knows them, listed even when it does not.
      const byId = new Map(all.models.map((m) => [m.id, m]));
      return json(res, 200, { supported: true, restricted: true, models: allowed.map((id) => byId.get(id) || { id, name: null }) });
    } },

    // The grouped view behind the tools panel: built-ins, and every MCP
    // server's tools under it with that server's connection health.
    { method: 'GET', path: /^\/api\/tools$/, feature: 'tools', handle: ({ res }) => json(res, 200, app.toolsView()) },

    // Per-tool approval override from the settings panel: 'ask', 'auto', or
    // 'default' to fall back to the global toolApproval mode.
    { method: 'POST', path: /^\/api\/tools\/approval$/, feature: 'tools', handle: async ({ req, res, auth }) => {
      const { name, policy } = await readJson(req);
      if (!name || !['ask', 'auto', 'default'].includes(policy)) {
        return json(res, 400, { error: 'name and policy (ask | auto | default) are required' });
      }
      app.cfg = app.saveConfig(setOverride(app.cfg, name, policy), actor(auth));
      return json(res, 200, app.toolsView());
    } },

    { method: 'POST', path: /^\/api\/tools\/toggle$/, feature: 'tools', handle: async ({ req, res, auth }) => {
      const { name, disabled } = await readJson(req);
      if (!name) return json(res, 400, { error: 'name is required' });
      const set = new Set(app.cfg.disabledTools || []);
      if (disabled) set.add(name); else set.delete(name);
      app.cfg = app.saveConfig({ disabledTools: [...set] }, actor(auth));
      return json(res, 200, app.toolsView());
    } }
  ];
}
