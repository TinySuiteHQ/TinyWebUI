import { json, readJson } from '../http.ts';
import { isClosed, findEntry, labelFor } from '../config/models.js';
import { modelsFor, fingerprint, resolveAccess, MIN_PASSWORD_LENGTH } from '../access/policy.js';
import {
  hashPassword, hashToken, verifyPassword, createSession, destroySession, sessionToken, sessionCookie, clearCookie, isSecureRequest
} from '../access/auth.js';
import { audit } from '../audit.ts';
import { OWNER_ID } from '../access/auth_gate.js';
import { normalizeEmail, validEmail } from '../access/email.js';
import { FEATURE } from '../../public/shared/features.js';

// Failed logins per client address: 5 misses locks that address out for 15 minutes.
const LOGIN_MAX = 5;
const LOGIN_WINDOW_MS = 15 * 60_000;
const DUMMY_PASSWORD_HASH = hashPassword('tinywebui timing placeholder');

function localAccount(body) {
  const email = normalizeEmail(body.email);
  const password = typeof body.password === 'string' ? body.password : '';
  if (!validEmail(email)) return { error: 'enter a valid email address' };
  if (password.length < MIN_PASSWORD_LENGTH) return { error: `use at least ${MIN_PASSWORD_LENGTH} characters` };
  if (password.length > 1024) return { error: 'password is too long' };
  return { email, password };
}

export function authRoutes({ config, modelFor, multiUser, source, store, version }) {
  const loginFailures = new Map();

  return [
    { method: 'GET', path: /^\/api\/auth\/me$/, feature: null, handle: ({ res, auth }) => {
      const cfg = config();
      const signedIn = auth.userId !== undefined;
      const model = signedIn ? modelFor(auth.user?.id, auth.role) : null;
      return json(res, 200, {
        authMode: cfg.authMode,
        needsSetup: cfg.authMode === 'multiuser' && store.users.localCount() === 0,
        logoutUrl: cfg.logoutUrl || '',
        isAdmin: Boolean(auth.isAdmin),
        // What this person may personalise, and their saved instructions (multi-user only).
        customize: multiUser() && auth.user ? resolveAccess(cfg).customize : [],
        instructions: multiUser() && auth.user ? store.users.getPrefs(auth.user.id).instructions || '' : '',
        features: [...auth.features],
        models: signedIn ? modelsFor(cfg, auth.role) : [],
        model,
        modelLabel: signedIn ? labelFor(cfg, model) : null,
        // What the catalog says this model can do; empty when it says nothing.
        modelTags: signedIn ? findEntry(cfg, model)?.tags || [] : [],
        user: auth.user
          ? { id: auth.user.id, email: auth.user.email, name: auth.user.name ?? null, role: auth.user.role, status: auth.user.status }
          : null
      });
    } },

    { method: 'POST', path: /^\/api\/auth\/login$/, feature: null, handle: async ({ req, res }) => {
      const cfg = config();
      if (cfg.authMode !== 'multiuser') return json(res, 404, { error: 'not found' });
      const who = req.socket.remoteAddress || '?';
      const now = Date.now();
      const f = loginFailures.get(who);
      if (f && now - f.first > LOGIN_WINDOW_MS) loginFailures.delete(who);
      const entry = loginFailures.get(who);
      if (entry && entry.count >= LOGIN_MAX) {
        return json(res, 429, { error: 'too many attempts, try again later' });
      }
      const body = await readJson(req);
      const password = typeof body.password === 'string' ? body.password : '';
      const user = store.users.byEmail(normalizeEmail(body.email));
      const stored = user?.password_hash || DUMMY_PASSWORD_HASH;
      if (!verifyPassword(password, stored) || !user) {
        loginFailures.set(who, { first: entry?.first ?? now, count: (entry?.count ?? 0) + 1 });
        audit('auth.rejected', { reason: 'bad_password' });
        return json(res, 401, { error: 'wrong email or password' });
      }
      if (user.status !== 'approved') return json(res, 403, { error: user.status === 'disabled' ? 'account disabled' : 'account pending approval' });
      loginFailures.delete(who);
      store.users.sync(user.id, { last_login_at: now });
      const token = createSession(store, user.id, cfg.sessionTtlDays);
      audit('auth.login', { userId: user.id });
      res.setHeader('set-cookie', sessionCookie(token, cfg.sessionSecret, { secure: isSecureRequest(req, cfg.trustedProxyCidrs) }));
      return json(res, 200, { ok: true });
    } },

    { method: 'POST', path: /^\/api\/auth\/setup$/, feature: null, handle: async ({ req, res }) => {
      const cfg = config();
      if (cfg.authMode !== 'multiuser') return json(res, 404, { error: 'not found' });
      if (store.users.localCount() !== 0) return json(res, 409, { error: 'this installation already has an administrator' });
      const account = localAccount(await readJson(req));
      if (account.error) return json(res, 400, { error: account.error });
      let user;
      try {
        user = store.users.createFirstLocal({ ...account, passwordHash: hashPassword(account.password) });
      } catch (err) {
        return json(res, 409, { error: 'that email address is already in use' });
      }
      if (!user) return json(res, 409, { error: 'this installation already has an administrator' });
      store.claimUnowned(user.id, { removeUserId: OWNER_ID });
      const token = createSession(store, user.id, cfg.sessionTtlDays);
      audit('user.provisioned', { userId: user.id, role: 'admin', status: 'approved', source: 'first-account' });
      audit('auth.login', { userId: user.id });
      res.setHeader('set-cookie', sessionCookie(token, cfg.sessionSecret, { secure: isSecureRequest(req, cfg.trustedProxyCidrs) }));
      return json(res, 201, { ok: true });
    } },

    { method: 'POST', path: /^\/api\/auth\/accept-invite$/, feature: null, handle: async ({ req, res }) => {
      const cfg = config();
      if (cfg.authMode !== 'multiuser') return json(res, 404, { error: 'not found' });
      const body = await readJson(req);
      const account = localAccount(body);
      if (account.error) return json(res, 400, { error: account.error });
      const inviteToken = typeof body.token === 'string' ? body.token.trim() : '';
      if (!/^[0-9a-f]{64}$/i.test(inviteToken)) return json(res, 400, { error: 'invalid or expired invitation' });
      let result;
      try {
        result = store.users.acceptInvite({
          tokenHash: hashToken(inviteToken), email: account.email,
          passwordHash: hashPassword(account.password)
        });
      } catch (err) {
        return json(res, 409, { error: 'that email address is already in use' });
      }
      if (result.error === 'email_mismatch') return json(res, 400, { error: 'this invitation is for a different email address' });
      if (result.error === 'email_taken') return json(res, 409, { error: 'that email address is already in use' });
      if (result.error) return json(res, 400, { error: 'invalid or expired invitation' });
      const token = createSession(store, result.user.id, cfg.sessionTtlDays);
      audit('user.provisioned', { userId: result.user.id, role: 'user', status: 'approved', source: 'invitation' });
      audit('auth.login', { userId: result.user.id });
      res.setHeader('set-cookie', sessionCookie(token, cfg.sessionSecret, { secure: isSecureRequest(req, cfg.trustedProxyCidrs) }));
      return json(res, 201, { ok: true });
    } },

    { method: 'POST', path: /^\/api\/auth\/logout$/, feature: null, handle: ({ req, res }) => {
      const cfg = config();
      // The gateway owns the session; the client is sent to its logout page.
      if (cfg.authMode === 'trusted-header') return json(res, 200, { redirect: cfg.logoutUrl || null });
      if (cfg.authMode !== 'multiuser') return json(res, 404, { error: 'not found' });
      const token = sessionToken(req, cfg);
      if (token) destroySession(store, token);
      res.setHeader('set-cookie', clearCookie({ secure: isSecureRequest(req, cfg.trustedProxyCidrs) }));
      return json(res, 200, { ok: true });
    } },

    // Tier 3's model pill: a personal choice among the role's models. In
    // tiers 1-2 the pill changes the configured model instead (/api/config).
    { method: 'POST', path: /^\/api\/me\/prefs$/, feature: null, handle: async ({ req, res, auth }) => {
      const cfg = config();
      if (!multiUser()) return json(res, 400, { error: 'preferences are per-user; set the model in settings' });
      const { model, instructions } = await readJson(req);
      if (instructions !== undefined) {
        if (!resolveAccess(cfg).customize.includes('instructions')) return json(res, 403, { error: 'your administrator has not enabled personal instructions' });
        if (instructions !== null && (typeof instructions !== 'string' || instructions.length > 4000)) return json(res, 400, { error: 'instructions must be text of at most 4000 characters, or null' });
        store.users.setPref(auth.user.id, 'instructions', instructions && instructions.trim() ? instructions.trim() : null);
        if (model === undefined) return json(res, 200, { instructions: instructions && instructions.trim() ? instructions.trim() : '' });
      }
      if (!auth.features.has(FEATURE.MODEL_PICKER)) return json(res, 403, { error: 'feature not available to your role', feature: FEATURE.MODEL_PICKER });
      if (model !== null && (typeof model !== 'string' || !model.trim())) return json(res, 400, { error: 'model must be a model id or null' });
      const allowed = modelsFor(cfg, auth.role);
      if (model && isClosed(cfg) && !findEntry(cfg, model)) return json(res, 403, { error: 'that model is not available to you' });
      if (model && allowed !== '*' && !allowed.includes(model)) return json(res, 403, { error: 'that model is not available to you' });
      store.users.setPref(auth.user.id, 'model', model ? model.trim() : null);
      return json(res, 200, { model: modelFor(auth.user.id, auth.role) });
    } },

    // Non-secret facts about this deployment, for scripts verifying what is
    // running: build, config hash, database schema, auth, MCP server names.
    { method: 'GET', path: /^\/api\/meta$/, feature: null, handle: ({ res }) => json(res, 200, {
      version: version,
      schemaVersion: store.schemaVersion(),
      fingerprint: fingerprint(config(), source.loadMcpServers()),
      configMode: source.isFrozen() ? 'frozen' : 'editable',
      authMode: config().authMode,
      mcpServers: Object.keys(source.loadMcpServers()).sort()
    }) }
  ];
}
