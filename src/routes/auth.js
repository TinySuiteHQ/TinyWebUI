import { json, readJson } from '../http.js';
import { isClosed, findEntry, labelFor } from '../models.js';
import { modelsFor, fingerprint } from '../policy.js';
import {
  verifyPassword, createSession, destroySession, sessionToken, sessionCookie, clearCookie, isSecureRequest, audit
} from '../auth.js';
import { OWNER_ID } from '../auth_gate.js';

// Failed logins per client address: 5 misses locks that address out for 15 minutes.
const LOGIN_MAX = 5;
const LOGIN_WINDOW_MS = 15 * 60_000;

export function authRoutes(app) {
  const loginFailures = new Map();
  const { store } = app;

  return [
    { method: 'GET', path: /^\/api\/auth\/me$/, feature: null, handle: ({ res, auth }) => {
      const { cfg } = app;
      const signedIn = auth.userId !== undefined;
      const model = signedIn ? app.modelFor(auth.user?.id, auth.role) : null;
      return json(res, 200, {
        authMode: cfg.authMode,
        logoutUrl: cfg.logoutUrl || '',
        isAdmin: Boolean(auth.isAdmin),
        features: [...auth.features],
        models: signedIn ? modelsFor(cfg, auth.role) : [],
        model,
        modelLabel: signedIn ? labelFor(cfg, model) : null,
        user: auth.user
          ? { id: auth.user.id, email: auth.user.email, name: auth.user.name ?? null, role: auth.user.role, status: auth.user.status }
          : null
      });
    } },

    { method: 'POST', path: /^\/api\/auth\/login$/, feature: null, handle: async ({ req, res }) => {
      const { cfg } = app;
      if (cfg.authMode !== 'single') return json(res, 404, { error: 'not found' });
      const who = req.socket.remoteAddress || '?';
      const now = Date.now();
      const f = loginFailures.get(who);
      if (f && now - f.first > LOGIN_WINDOW_MS) loginFailures.delete(who);
      const entry = loginFailures.get(who);
      if (entry && entry.count >= LOGIN_MAX) {
        return json(res, 429, { error: 'too many attempts, try again later' });
      }
      const { password } = await readJson(req);
      if (!verifyPassword(password, app.passwordHash)) {
        loginFailures.set(who, { first: entry?.first ?? now, count: (entry?.count ?? 0) + 1 });
        audit('auth.rejected', { reason: 'bad_password' });
        return json(res, 401, { error: 'wrong password' });
      }
      loginFailures.delete(who);
      const token = createSession(store, OWNER_ID, cfg.sessionTtlDays);
      audit('auth.login', { userId: OWNER_ID });
      res.setHeader('set-cookie', sessionCookie(token, cfg.sessionSecret, { secure: isSecureRequest(req, cfg.trustedProxyCidrs) }));
      return json(res, 200, { ok: true });
    } },

    { method: 'POST', path: /^\/api\/auth\/logout$/, feature: null, handle: ({ req, res }) => {
      const { cfg } = app;
      // The gateway owns the session; the client is sent to its logout page.
      if (cfg.authMode === 'trusted-header') return json(res, 200, { redirect: cfg.logoutUrl || null });
      if (cfg.authMode !== 'single') return json(res, 404, { error: 'not found' });
      const token = sessionToken(req, cfg);
      if (token) destroySession(store, token);
      res.setHeader('set-cookie', clearCookie({ secure: isSecureRequest(req, cfg.trustedProxyCidrs) }));
      return json(res, 200, { ok: true });
    } },

    // Tier 3's model pill: a personal choice among the role's models. In
    // tiers 1-2 the pill changes the configured model instead (/api/config).
    { method: 'POST', path: /^\/api\/me\/prefs$/, feature: 'model-picker', handle: async ({ req, res, auth }) => {
      const { cfg } = app;
      if (!app.multiUser()) return json(res, 400, { error: 'preferences are per-user; set the model in settings' });
      const { model } = await readJson(req);
      if (model !== null && (typeof model !== 'string' || !model.trim())) return json(res, 400, { error: 'model must be a model id or null' });
      const allowed = modelsFor(cfg, auth.role);
      if (model && isClosed(cfg) && !findEntry(cfg, model)) return json(res, 403, { error: 'that model is not available to you' });
      if (model && allowed !== '*' && !allowed.includes(model)) return json(res, 403, { error: 'that model is not available to you' });
      store.setPref(auth.user.id, 'model', model ? model.trim() : null);
      return json(res, 200, { model: app.modelFor(auth.user.id, auth.role) });
    } },

    // Non-secret facts about this deployment, for scripts verifying what is
    // running: build, config hash, database schema, auth, MCP server names.
    { method: 'GET', path: /^\/api\/meta$/, feature: null, handle: ({ res }) => json(res, 200, {
      version: app.version,
      schemaVersion: store.schemaVersion(),
      fingerprint: fingerprint(app.cfg, app.source.loadMcpServers()),
      configMode: app.source.isFrozen() ? 'frozen' : 'editable',
      authMode: app.cfg.authMode,
      mcpServers: Object.keys(app.source.loadMcpServers()).sort()
    }) }
  ];
}
