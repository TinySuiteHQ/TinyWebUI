import { json, readJson } from '../http.js';
import { ALL_USERS, toView } from '../store/index.js';
import { validateConfig, fingerprint, resolveAccess, FEATURES, CUSTOMIZABLE } from '../access/policy.js';
import { catalog, modelProblems } from '../config/models.js';
import { destroyUserSessions } from '../access/auth.js';
import { audit } from '../audit.js';
import { FEATURE } from '../../public/shared/features.js';

function adminUserView(u) {
  return {
    id: u.id, email: u.email, name: u.name ?? null, role: u.role, status: u.status,
    createdAt: u.created_at, lastLoginAt: u.last_login_at, chatCount: u.chat_count ?? null
  };
}

/**
 * User management and oversight. They only mean something when there is more
 * than one person; 'none' and 'single' are just you, and get admin_only.
 */
export function adminRoutes({ config, multiUser, refreshConfig, runs, source, store }) {

  // Wraps a handler so it refuses outside multi-user deployments.
  const multi = (handle) => (ctx) => (multiUser() ? handle(ctx) : json(ctx.res, 403, { error: 'admin_only' }));

  return [
    { method: 'GET', path: /^\/api\/admin\/users$/, feature: FEATURE.ADMIN, handle: multi(({ res }) => {
      const pins = resolveAccess(config());
      const code = source.codeAccessUsers();
      const pinnedBy = (u) => (pins.bootstrapAdmins.includes(u.external_id) ? 'bootstrapAdmins'
        : code[u.external_id] ? 'access.users' : null);
      return json(res, 200, {
        fingerprint: fingerprint(config(), source.loadMcpServers()),
        users: store.users.list().map((u) => ({ ...adminUserView(u), pinnedInCode: pinnedBy(u) }))
      });
    }) },

    { method: 'PATCH', path: /^\/api\/admin\/users\/([\w-]+)$/, feature: FEATURE.ADMIN, handle: multi(async ({ req, res, auth, params: [id] }) => {
      const target = store.users.get(id);
      if (!target) return json(res, 404, { error: 'no such user' });
      const { role, status } = await readJson(req);
      if (role !== undefined && !['admin', 'user'].includes(role)) return json(res, 400, { error: 'role must be admin or user' });
      if (status !== undefined && !['pending', 'approved', 'disabled'].includes(status)) {
        return json(res, 400, { error: 'status must be pending, approved or disabled' });
      }
      if (target.id === auth.userId && ((role && role !== 'admin') || (status && status !== 'approved'))) {
        return json(res, 400, { error: 'you cannot demote or disable your own account' });
      }
      const pins = resolveAccess(config());
      if (target.external_id && pins.bootstrapAdmins.includes(target.external_id)) {
        return json(res, 400, { error: 'this admin is declared in code (access.bootstrapAdmins)' });
      }
      // The file is the record: the decision goes into config.json's
      // access.users first, and only then into the database.
      if (target.external_id) {
        const file = source.readFile();
        const access = file.access && typeof file.access === 'object' ? file.access : {};
        const users = { ...(access.users || {}) };
        users[target.external_id] = {
          ...(users[target.external_id] || {}),
          ...(role !== undefined ? { role } : {}),
          ...(status !== undefined ? { status } : {})
        };
        const merged = { ...file, access: { ...access, users } };
        const problems = validateConfig({ ...config(), access: merged.access });
        if (problems.length) return json(res, 400, { error: problems.join('; ') });
        if (source.codeAccessUsers()[target.external_id]) return json(res, 409, { error: 'this user is pinned in code (access.users)' });
        source.writeFile(merged);
        refreshConfig();
      }
      const updated = store.users.update(target.id, { role, status });
      if (role !== undefined && role !== target.role) {
        audit('user.role_changed', { userId: target.id, from: target.role, to: role, by: auth.userId });
      }
      if (status !== undefined && status !== target.status) {
        audit('user.status_changed', { userId: target.id, from: target.status, to: status, by: auth.userId });
        if (status !== 'approved') destroyUserSessions(store, target.id);
      }
      return json(res, 200, { user: adminUserView(updated) });
    }) },

    // What the `user` role may do, what new users start as, and what users may
    // personalise. The admin role is not editable here: it cannot be locked
    // out of the panel that edits it. Written to the file like every decision.
    { method: 'GET', path: /^\/api\/admin\/policy$/, feature: FEATURE.ADMIN, handle: multi(({ res }) => {
      const a = resolveAccess(config());
      return json(res, 200, {
        features: FEATURES, customizable: CUSTOMIZABLE, models: catalog(config()).map((m) => m.id),
        user: a.roles.user, newUsers: a.newUsers, customize: a.customize,
        locked: source.lockedKeys().has('access')
      });
    }) },

    { method: 'POST', path: /^\/api\/admin\/policy$/, feature: FEATURE.ADMIN, handle: multi(async ({ req, res, auth }) => {
      if (source.isFrozen() || source.lockedKeys().has('access')) return json(res, 409, { error: 'access is set in code or frozen: change the files instead' });
      const { features, models, newUsers, customize } = await readJson(req);
      const file = source.readFile();
      const access = file.access && typeof file.access === 'object' ? file.access : {};
      const user = { ...(access.roles?.user || {}) };
      if (features !== undefined) user.features = features;
      if (models !== undefined) user.models = models;
      const merged = {
        ...access,
        roles: { ...(access.roles || {}), user },
        ...(newUsers !== undefined ? { newUsers } : {}),
        ...(customize !== undefined ? { customize } : {})
      };
      const next = { ...file, access: merged };
      const problems = [...validateConfig({ ...config(), access: merged }), ...modelProblems({ ...config(), access: merged })];
      if (problems.length) return json(res, 400, { error: problems.join('; ') });
      source.writeFile(next);
      refreshConfig();
      audit('admin.policy_changed', { by: auth.userId, user, newUsers: merged.newUsers ?? null, customize: merged.customize ?? null });
      const a = resolveAccess(config());
      return json(res, 200, { user: a.roles.user, newUsers: a.newUsers, customize: a.customize });
    }) },

    // Oversight: read-only, every view audited. Reached through ALL_USERS on
    // purpose -- this is the one place a user's scope is crossed, and it only
    // exists when there are users to cross between.
    { method: 'GET', path: /^\/api\/admin\/users\/([\w-]+)\/chats$/, feature: FEATURE.OVERSIGHT, handle: multi(({ res, auth, params: [id] }) => {
      const target = store.users.get(id);
      if (!target) return json(res, 404, { error: 'no such user' });
      audit('admin.view_user_chats', { by: auth.userId, userId: target.id });
      const chats = store.chats.list(500, target.id).map((c) => ({ ...c, running: runs.isRunning(c.id) }));
      return json(res, 200, { user: adminUserView(target), chats, summary: store.usage.statistics(target.id).summary });
    }) },

    { method: 'GET', path: /^\/api\/admin\/chats\/([\w.-]+)$/, feature: FEATURE.OVERSIGHT, handle: multi(({ res, auth, params: [id] }) => {
      const found = store.chats.get(id, ALL_USERS);
      if (!found) return json(res, 404, { error: 'no such chat' });
      audit('admin.view_chat', { by: auth.userId, chatId: found.id, owner: found.user_id });
      const owner = found.user_id ? store.users.get(found.user_id) : null;
      return json(res, 200, {
        id: found.id, title: found.title, updatedAt: found.updated_at,
        owner: owner ? adminUserView(owner) : null,
        running: runs.isRunning(found.id),
        messages: store.messages.list(found.id).map(toView),
        documents: store.documents.list(found.id)
      });
    }) },

    { method: 'GET', path: /^\/api\/admin\/documents\/([\w.-]+)$/, feature: FEATURE.OVERSIGHT, handle: multi(({ res, auth, params: [id] }) => {
      const doc = store.documents.get(id, ALL_USERS);
      if (!doc) return json(res, 404, { error: 'no such document' });
      audit('admin.view_document', { by: auth.userId, documentId: doc.id, chatId: doc.chat_id });
      return json(res, 200, { filename: doc.filename, mime: doc.mime, content: doc.content });
    }) }
  ];
}
