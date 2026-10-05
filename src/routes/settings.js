import { json, readJson } from '../http.js';
import { isClosed, enabledEntries, publicEntry, findConnector } from '../config/models.js';
import { modelsFor, SECRET_PATCH_KEYS } from '../access/policy.js';
import { audit } from '../audit.js';
import { setOverride } from '../config/approval.js';
import { actor } from '../access/auth_gate.js';
import { FEATURE } from '../../public/shared/features.js';

export const toolList = (hub) => hub.tools.map((t) => ({
  name: t.function.name,
  description: t.function.description,
  parameters: t.function.parameters
}));

export function settingsRoutes({ config, configFor, hub, saveConfig, toolsView }) {
  // The provider's model list, cached per endpoint for a few minutes:
  // OpenRouter's list is large and the picker is opened far more often than
  // the catalogue changes.
  let modelCache = null;
  const listModels = async () => {
    const cfg = config();
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
      ...configFor(auth),
      tools: toolList(hub()),
      mcpErrors: hub().errors
    }) },

    { method: 'POST', path: /^\/api\/config$/, feature: FEATURE.SETTINGS, handle: async ({ req, res, auth }) => {
      const patch = await readJson(req);
      // Credentials and routing: the sole user or an admin, not any role that
      // was merely granted the settings feature.
      const secret = Object.keys(patch).filter((k) => SECRET_PATCH_KEYS.has(k));
      if (secret.length && !auth.isAdmin) return json(res, 403, { error: `only an admin can change: ${secret.join(', ')}` });
      saveConfig(patch, actor(auth));
      audit('admin.config_changed', { by: auth.userId ?? null });
      return json(res, 200, configFor(auth));
    } },

    // The provider's own model list, for the composer's model picker. Not
    // every OpenAI-compatible endpoint serves /models, so a failure is an
    // answer too: the picker falls back to typing an id.
    { method: 'GET', path: /^\/api\/models$/, feature: FEATURE.MODEL_PICKER, handle: async ({ res, auth }) => {
      const cfg = config();
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

    // "Test connection" for the connector editor. A key typed into the form is
    // used as is; a blank one means the stored key of that connector ('default'
    // is the top-level baseUrl/apiKey), since the page never holds keys.
    { method: 'POST', path: /^\/api\/connectors\/test$/, feature: FEATURE.SETTINGS, handle: async ({ req, res, auth }) => {
      if (!auth.isAdmin) return json(res, 403, { error: 'only an admin can test connectors' });
      const body = await readJson(req);
      const cfg = config();
      const stored = body.id && body.id !== 'default' ? findConnector(cfg, body.id) : { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey };
      const baseUrl = String(body.baseUrl || stored?.baseUrl || '').replace(/\/+$/, '');
      const apiKey = body.apiKey || stored?.apiKey || '';
      if (!/^https?:\/\//.test(baseUrl)) return json(res, 400, { error: 'baseUrl must be an http(s) URL' });
      try {
        const r = await fetch(`${baseUrl}/models`, {
          headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
          signal: AbortSignal.timeout(8000)
        });
        if (r.status === 401 || r.status === 403) return json(res, 200, { ok: false, error: `${r.status}: the endpoint rejected the key` });
        // Not every OpenAI-compatible server lists models; reachable is the point.
        const list = r.ok ? await r.json().catch(() => null) : null;
        const rows = Array.isArray(list?.data) ? list.data : Array.isArray(list?.models) ? list.models : null;
        return json(res, 200, { ok: r.status < 500, status: r.status, models: rows ? rows.length : null });
      } catch (err) {
        return json(res, 200, { ok: false, error: err.message });
      }
    } },

    // The grouped view behind the tools panel: built-ins, and every MCP
    // server's tools under it with that server's connection health.
    { method: 'GET', path: /^\/api\/tools$/, feature: FEATURE.TOOLS, handle: ({ res }) => json(res, 200, toolsView()) },

    // Per-tool approval override from the settings panel: 'ask', 'auto', or
    // 'default' to fall back to the global toolApproval mode.
    { method: 'POST', path: /^\/api\/tools\/approval$/, feature: FEATURE.TOOLS, handle: async ({ req, res, auth }) => {
      const { name, policy } = await readJson(req);
      if (!name || !['ask', 'auto', 'default'].includes(policy)) {
        return json(res, 400, { error: 'name and policy (ask | auto | default) are required' });
      }
      saveConfig(setOverride(config(), name, policy), actor(auth));
      return json(res, 200, toolsView());
    } },

    { method: 'POST', path: /^\/api\/tools\/toggle$/, feature: FEATURE.TOOLS, handle: async ({ req, res, auth }) => {
      const { name, disabled } = await readJson(req);
      if (!name) return json(res, 400, { error: 'name is required' });
      const set = new Set(config().disabledTools || []);
      if (disabled) set.add(name); else set.delete(name);
      saveConfig({ disabledTools: [...set] }, actor(auth));
      return json(res, 200, toolsView());
    } }
  ];
}
