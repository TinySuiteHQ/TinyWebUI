import { json, readJson } from '../http.js';
import { ALL_USERS, toView } from '../store.js';
import { validateConfig, fingerprint, resolveAccess } from '../access/policy.js';
import { destroyUserSessions, audit } from '../access/auth.js';

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
export function adminRoutes(app) {
  const { store, source, runs } = app;

  // Wraps a handler so it refuses outside multi-user deployments.
  const multi = (handle) => (ctx) => (app.multiUser() ? handle(ctx) : json(ctx.res, 403, { error: 'admin_only' }));

  return [
    { method: 'GET', path: /^\/api\/admin\/users$/, feature: 'admin', handle: multi(({ res }) => {
      const pins = resolveAccess(app.cfg);
      const code = source.codeAccessUsers();
      const pinnedBy = (u) => (pins.bootstrapAdmins.includes(u.external_id) ? 'bootstrapAdmins'
        : code[u.external_id] ? 'access.users' : null);
      return json(res, 200, {
        fingerprint: fingerprint(app.cfg, source.loadMcpServers()),
        users: store.listUsers().map((u) => ({ ...adminUserView(u), pinnedInCode: pinnedBy(u) }))
      });
    }) },

    { method: 'PATCH', path: /^\/api\/admin\/users\/([\w-]+)$/, feature: 'admin', handle: multi(async ({ req, res, auth, params: [id] }) => {
      const target = store.getUser(id);
      if (!target) return json(res, 404, { error: 'no such user' });
      const { role, status } = await readJson(req);
      if (role !== undefined && !['admin', 'user'].includes(role)) return json(res, 400, { error: 'role must be admin or user' });
      if (status !== undefined && !['pending', 'approved', 'disabled'].includes(status)) {
        return json(res, 400, { error: 'status must be pending, approved or disabled' });
      }
      if (target.id === auth.userId && ((role && role !== 'admin') || (status && status !== 'approved'))) {
        return json(res, 400, { error: 'you cannot demote or disable your own account' });
      }
      const pins = resolveAccess(app.cfg);
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
        const problems = validateConfig({ ...app.cfg, access: merged.access });
        if (problems.length) return json(res, 400, { error: problems.join('; ') });
        if (source.codeAccessUsers()[target.external_id]) return json(res, 409, { error: 'this user is pinned in code (access.users)' });
        source.writeFile(merged);
        app.cfg = source.load();
      }
      const updated = store.updateUser(target.id, { role, status });
      if (role !== undefined && role !== target.role) {
        audit('user.role_changed', { userId: target.id, from: target.role, to: role, by: auth.userId });
      }
      if (status !== undefined && status !== target.status) {
        audit('user.status_changed', { userId: target.id, from: target.status, to: status, by: auth.userId });
        if (status !== 'approved') destroyUserSessions(store, target.id);
      }
      return json(res, 200, { user: adminUserView(updated) });
    }) },

    // Oversight: read-only, every view audited. Reached through ALL_USERS on
    // purpose -- this is the one place a user's scope is crossed, and it only
    // exists when there are users to cross between.
    { method: 'GET', path: /^\/api\/admin\/users\/([\w-]+)\/chats$/, feature: 'oversight', handle: multi(({ res, auth, params: [id] }) => {
      const target = store.getUser(id);
      if (!target) return json(res, 404, { error: 'no such user' });
      audit('admin.view_user_chats', { by: auth.userId, userId: target.id });
      const chats = store.listChats(500, target.id).map((c) => ({ ...c, running: runs.isRunning(c.id) }));
      return json(res, 200, { user: adminUserView(target), chats, summary: store.usageStatistics(target.id).summary });
    }) },

    { method: 'GET', path: /^\/api\/admin\/chats\/([\w.-]+)$/, feature: 'oversight', handle: multi(({ res, auth, params: [id] }) => {
      const found = store.getChat(id, ALL_USERS);
      if (!found) return json(res, 404, { error: 'no such chat' });
      audit('admin.view_chat', { by: auth.userId, chatId: found.id, owner: found.user_id });
      const owner = found.user_id ? store.getUser(found.user_id) : null;
      return json(res, 200, {
        id: found.id, title: found.title, updatedAt: found.updated_at,
        owner: owner ? adminUserView(owner) : null,
        running: runs.isRunning(found.id),
        messages: store.messages(found.id).map(toView),
        documents: store.listDocuments(found.id)
      });
    }) },

    { method: 'GET', path: /^\/api\/admin\/documents\/([\w.-]+)$/, feature: 'oversight', handle: multi(({ res, auth, params: [id] }) => {
      const doc = store.getDocument(id, ALL_USERS);
      if (!doc) return json(res, 404, { error: 'no such document' });
      audit('admin.view_document', { by: auth.userId, documentId: doc.id, chatId: doc.chat_id });
      return json(res, 200, { filename: doc.filename, mime: doc.mime, content: doc.content });
    }) }
  ];
}
