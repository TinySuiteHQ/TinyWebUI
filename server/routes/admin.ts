import { randomBytes, randomUUID } from 'node:crypto';
import { json, readJson, oneOf } from '../http.ts';
import { ALL_USERS, toView } from '../store/index.ts';
import {
  validateConfig, fingerprint, resolveAccess, roleNames, passwordProblem, FEATURES, CUSTOMIZABLE, BUILTIN_ROLES, ROLE_NAME, STATUSES,
  type AccessConfig, type Feature, type RoleModelSettings, type RoleSettings, type RoleSpec
} from '../access/policy.ts';
import { catalog, modelProblems } from '../config/models.ts';
import { destroyUserSessions, hashPassword, hashToken } from '../access/auth.ts';
import { normalizeEmail, validEmail } from '../access/email.ts';
import { audit } from '../audit.ts';
import { FEATURE } from '../../shared/features.ts';
import type { Route, RouteContext, RouteDeps } from './types.ts';
import type { SignedIn } from '../access/auth_gate.ts';
import type { UserListing, UserRow } from '../store/users.ts';
import type {
  AdminChatReply, AdminChatsReply, AdminPolicyReply, AdminUserView, AdminUsersReply, DocumentTextReply, InviteCreatedReply, InviteView, RoleView
} from '../../shared/api.ts';

/** Multi-user, behind the admin or oversight feature: someone is signed in. */
type AdminContext = RouteContext<SignedIn & { user: UserRow }>;

function adminUserView(u: Omit<UserListing, 'chat_count' | 'has_password'> & { chat_count?: number; has_password?: number; password_hash?: string | null }): AdminUserView {
  return {
    id: u.id, email: u.email, name: u.name ?? null, role: u.role, status: u.status,
    createdAt: u.created_at, lastLoginAt: u.last_login_at, chatCount: u.chat_count ?? null,
    // A local account an admin can set a password for; gateway (SSO) accounts have none.
    hasPassword: Boolean(u.has_password ?? u.password_hash),
    // Only while the request is waiting: once decided, it has done its job.
    note: u.status === 'pending' ? u.request_note ?? null : null
  };
}

/**
 * User management and oversight. They only mean something when there is more
 * than one person; 'single' is just you, and gets admin_only.
 */
export function adminRoutes({ config, multiUser, refreshConfig, runs, source, store }: Pick<RouteDeps, 'config' | 'multiUser' | 'refreshConfig' | 'runs' | 'source' | 'store'>): Route[] {

  // Wraps a handler so it refuses outside multi-user deployments.
  const multi = (handle: (ctx: AdminContext) => unknown) => (ctx: RouteContext<SignedIn>) =>
    (multiUser() ? handle(ctx as AdminContext) : json(ctx.res, 403, { error: 'admin_only' }));

  /**
   * Rewrites the file's access block, which is the record of every policy
   * decision. Refuses when code or a freeze owns it, and when the result
   * would not load; otherwise writes and reloads. Returns the refusal, or null.
   */
  const writeAccess = (change: (access: AccessConfig) => AccessConfig): { status: number; error: string } | null => {
    if (source.isFrozen() || source.lockedKeys().has('access')) return { status: 409, error: 'access is set in code or frozen: change the files instead' };
    const file = source.readFile();
    const access = change(file.access && typeof file.access === 'object' ? file.access : {});
    const problems = [...validateConfig({ ...config(), access }), ...modelProblems({ ...config(), access })];
    if (problems.length) return { status: 400, error: problems.join('; ') };
    source.writeFile({ ...file, access });
    refreshConfig();
    return null;
  };

  /** Writes what a role grants into the file: a new role, or the fields sent for an existing one. */
  const saveRole = (name: string, body: Record<string, unknown>, auth: AdminContext['auth'], res: AdminContext['res'], created: boolean) => {
    const { features, models, customize, settings, modelSettings } = body;
    const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
    if (features !== undefined && !strings(features)) return json(res, 400, { error: 'features must be a list' });
    if (models !== undefined && models !== '*' && !strings(models)) return json(res, 400, { error: "models must be '*' or a list" });
    if (customize !== undefined && !strings(customize)) return json(res, 400, { error: 'customize must be a list' });
    const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
    if (settings !== undefined && !isObject(settings)) return json(res, 400, { error: 'settings must be an object' });
    if (modelSettings !== undefined && !(isObject(modelSettings) && Object.values(modelSettings).every(isObject))) {
      return json(res, 400, { error: 'modelSettings must be an object of model id to settings' });
    }
    // A blank value inherits, so it is left out rather than stored, and so is a
    // model left with nothing set. Each kept value is checked by validateConfig
    // before anything is written.
    const filled = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== ''));
    const kept = settings ? filled(settings) as RoleSettings : null;
    const keptPerModel = modelSettings
      ? Object.fromEntries(Object.entries(modelSettings).map(([m, o]) => [m, filled(o as Record<string, unknown>)]).filter(([, o]) => Object.keys(o).length)) as Record<string, RoleModelSettings>
      : null;
    let spec: RoleSpec = {};
    const refused = writeAccess((access) => {
      // What is sent replaces what was there, so a blanked block is removed, not kept.
      const previous: RoleSpec = { ...(access.roles?.[name] || {}) };
      if (kept) delete previous.settings;
      if (keptPerModel) delete previous.modelSettings;
      spec = {
        ...previous,
        // Names only so far: validateConfig rejects any that is not a feature before anything is written.
        ...(features !== undefined ? { features: features as Feature[] } : {}),
        ...(models !== undefined ? { models } : {}),
        ...(customize !== undefined ? { customize } : {}),
        ...(kept && Object.keys(kept).length ? { settings: kept } : {}),
        ...(keptPerModel && Object.keys(keptPerModel).length ? { modelSettings: keptPerModel } : {})
      };
      return { ...access, roles: { ...(access.roles || {}), [name]: spec } };
    });
    if (refused) return json(res, refused.status, { error: refused.error });
    audit(created ? 'admin.role_created' : 'admin.role_changed', { by: auth.userId, role: name, spec });
    return json(res, created ? 201 : 200, { roles: rolesView() } satisfies { roles: RoleView[] });
  };

  // Each role as the Roles tab shows it: what it grants, spelled out, and who holds it.
  const rolesView = (): RoleView[] => {
    const { roles } = resolveAccess(config());
    const counts = store.users.roleCounts();
    return Object.entries(roles).map(([name, spec]) => ({
      name, builtin: BUILTIN_ROLES.includes(name), fixed: name === 'admin',
      features: spec.features === '*' ? FEATURES : spec.features,
      models: spec.models, customize: spec.customize, settings: spec.settings, modelSettings: spec.modelSettings, users: counts[name] || 0
    }));
  };

  return [
    { method: 'GET', path: /^\/api\/admin\/invites$/, feature: FEATURE.ADMIN, handle: multi(({ res }) => {
      return json(res, 200, { invites: store.users.listInvites().map((i): InviteView => ({
        id: i.id, email: i.email, createdAt: i.created_at, expiresAt: i.expires_at
      })) });
    }) },

    { method: 'POST', path: /^\/api\/admin\/invites$/, feature: FEATURE.ADMIN, handle: multi(async ({ req, res, auth }) => {
      if (config().authMode !== 'multiuser') return json(res, 400, { error: 'local invitations are only available in multiuser mode' });
      const body = await readJson(req);
      const email = normalizeEmail(body.email) || null;
      if (email && !validEmail(email)) return json(res, 400, { error: 'enter a valid email address' });
      if (email && store.users.emailTaken(email, '')) return json(res, 409, { error: 'that email address already belongs to a user' });
      const hours = body.expiresHours === undefined ? 168 : Number(body.expiresHours);
      if (!(Number.isFinite(hours) && hours >= 1 && hours <= 720)) return json(res, 400, { error: 'expiry must be between 1 and 720 hours' });
      const token = randomBytes(32).toString('hex');
      const invite = store.users.createInvite({
        id: randomUUID(), tokenHash: hashToken(token), email, createdBy: auth.user.id,
        expiresAt: Date.now() + Math.round(hours * 3600_000)
      });
      audit('invite.created', { inviteId: invite.id, email, by: auth.user.id, expiresAt: invite.expires_at });
      return json(res, 201, {
        invite: { id: invite.id, email, createdAt: invite.created_at, expiresAt: invite.expires_at },
        token, path: `/?invite=${token}`
      } satisfies InviteCreatedReply);
    }) },

    { method: 'DELETE', path: /^\/api\/admin\/invites\/([\w-]+)$/, feature: FEATURE.ADMIN, handle: multi(({ res, auth, params: [id] }) => {
      if (!store.users.revokeInvite(id)) return json(res, 404, { error: 'no active invitation with that id' });
      audit('invite.revoked', { inviteId: id, by: auth.user.id });
      return json(res, 200, { ok: true });
    }) },

    { method: 'GET', path: /^\/api\/admin\/users$/, feature: FEATURE.ADMIN, handle: multi(({ res }) => {
      const pins = resolveAccess(config());
      const code = source.codeAccessUsers();
      const pinnedBy = (u: UserListing) => (pins.bootstrapAdmins.includes(u.external_id as string) ? 'bootstrapAdmins'
        : code[u.external_id as string] ? 'access.users' : null);
      return json(res, 200, {
        fingerprint: fingerprint(config(), source.loadMcpServers()),
        users: store.users.list().map((u) => ({ ...adminUserView(u), pinnedInCode: pinnedBy(u) }))
      } satisfies AdminUsersReply);
    }) },

    { method: 'PATCH', path: /^\/api\/admin\/users\/([\w-]+)$/, feature: FEATURE.ADMIN, handle: multi(async ({ req, res, auth, params: [id] }) => {
      const target = store.users.get(id);
      if (!target) return json(res, 404, { error: 'no such user' });
      const { role, status } = await readJson(req);
      const roles = roleNames(config());
      if (role !== undefined && !oneOf(role, roles)) return json(res, 400, { error: `role must be one of ${roles.join(', ')}` });
      if (status !== undefined && !oneOf(status, STATUSES)) {
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
      return json(res, 200, { user: adminUserView(updated!) });
    }) },

    // Someone locked out (there is no email reset) gets a new password from an
    // admin. Same rule as everywhere; every session of theirs ends. Your own
    // goes through Settings → Account, which asks for the current one.
    { method: 'POST', path: /^\/api\/admin\/users\/([\w-]+)\/password$/, feature: FEATURE.ADMIN, handle: multi(async ({ req, res, auth, params: [id] }) => {
      if (config().authMode !== 'multiuser') return json(res, 404, { error: 'passwords belong to the sign-in gateway here' });
      const target = store.users.get(id);
      if (!target) return json(res, 404, { error: 'no such user' });
      if (target.id === auth.userId) return json(res, 400, { error: 'change your own password under Settings → Account' });
      if (!target.password_hash) return json(res, 400, { error: 'this account signs in another way and has no password' });
      const { password } = await readJson(req);
      const problem = passwordProblem(password);
      if (problem) return json(res, 400, { error: problem });
      store.users.setPassword(target.id, hashPassword(password));
      destroyUserSessions(store, target.id);
      audit('auth.password_changed', { userId: target.id, by: auth.userId });
      return json(res, 200, { ok: true });
    }) },

    // The roles and what each may do. The admin role is shown but not
    // editable: it cannot be locked out of the panel that edits it. Every
    // change is written to the file like any other decision. How new people
    // start (access.newUsers) is not offered: they wait for an admin unless
    // the files say otherwise.
    { method: 'GET', path: /^\/api\/admin\/policy$/, feature: FEATURE.ADMIN, handle: multi(({ res }) => {
      return json(res, 200, {
        features: FEATURES, customizable: CUSTOMIZABLE, models: catalog(config()).map((m) => m.id),
        roles: rolesView(), newUsers: resolveAccess(config()).newUsers, allowRequests: resolveAccess(config()).allowRequests,
        locked: source.isFrozen() || source.lockedKeys().has('access')
      } satisfies AdminPolicyReply);
    }) },

    // Whether the sign-in page offers "Request access". Written to the file like any other decision.
    { method: 'PATCH', path: /^\/api\/admin\/policy$/, feature: FEATURE.ADMIN, handle: multi(async ({ req, res, auth }) => {
      const { allowRequests } = await readJson(req);
      if (typeof allowRequests !== 'boolean') return json(res, 400, { error: 'allowRequests must be true or false' });
      const refused = writeAccess((access) => ({ ...access, allowRequests }));
      if (refused) return json(res, refused.status, { error: refused.error });
      audit('admin.requests_changed', { by: auth.userId, allowRequests });
      return json(res, 200, { allowRequests: resolveAccess(config()).allowRequests });
    }) },

    { method: 'POST', path: /^\/api\/admin\/roles$/, feature: FEATURE.ADMIN, handle: multi(async ({ req, res, auth }) => {
      const body = await readJson(req);
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!ROLE_NAME.test(name)) return json(res, 400, { error: 'a role name is lowercase letters, digits and dashes, starting with a letter (at most 32)' });
      if (roleNames(config()).includes(name)) return json(res, 409, { error: `there is already a role called ${name}` });
      return saveRole(name, body, auth, res, true);
    }) },

    // Only the fields sent change.
    { method: 'PATCH', path: /^\/api\/admin\/roles\/([\w-]+)$/, feature: FEATURE.ADMIN, handle: multi(async ({ req, res, auth, params: [name] }) => {
      if (!roleNames(config()).includes(name)) return json(res, 404, { error: 'no such role' });
      const body = await readJson(req);
      // Admins always have everything; what their chats run with is still the admin's to set.
      if (name === 'admin' && Object.keys(body).some((k) => k !== 'settings' && k !== 'modelSettings')) return json(res, 400, { error: 'the admin role always has everything; only its settings can change' });
      return saveRole(name, body, auth, res, false);
    }) },

    // A custom role's people fall back to the user role, in the file and the database.
    { method: 'DELETE', path: /^\/api\/admin\/roles\/([\w-]+)$/, feature: FEATURE.ADMIN, handle: multi(({ res, auth, params: [name] }) => {
      if (BUILTIN_ROLES.includes(name)) return json(res, 400, { error: 'the admin and user roles cannot be deleted' });
      const file = source.readFile();
      if (!Object.hasOwn(file.access?.roles || {}, name)) return json(res, 404, { error: 'no such role in the config file' });
      const refused = writeAccess((access) => {
        const roles = { ...(access.roles || {}) };
        delete roles[name];
        if (!access.users) return { ...access, roles };
        const users = Object.fromEntries(Object.entries(access.users)
          .map(([id, pin]) => [id, pin.role === name ? { ...pin, role: 'user' } : pin]));
        return { ...access, roles, users };
      });
      if (refused) return json(res, refused.status, { error: refused.error });
      const moved = store.users.moveRole(name, 'user');
      audit('admin.role_deleted', { by: auth.userId, role: name, moved });
      return json(res, 200, { roles: rolesView(), moved } satisfies { roles: RoleView[], moved: number });
    }) },

    // Oversight: read-only, every view audited. Reached through ALL_USERS on
    // purpose -- this is the one place a user's scope is crossed, and it only
    // exists when there are users to cross between.
    { method: 'GET', path: /^\/api\/admin\/users\/([\w-]+)\/chats$/, feature: FEATURE.OVERSIGHT, handle: multi(({ res, auth, params: [id] }) => {
      const target = store.users.get(id);
      if (!target) return json(res, 404, { error: 'no such user' });
      audit('admin.view_user_chats', { by: auth.userId, userId: target.id });
      const chats = store.chats.list(500, target.id).map((c) => ({ ...c, running: runs.isRunning(c.id) }));
      // The figures the oversight header shows.
      const { rounds, pricedRounds, reportedCost } = store.usage.statistics(target.id);
      return json(res, 200, { user: adminUserView(target), chats, summary: { rounds, pricedRounds, reportedCost } } satisfies AdminChatsReply);
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
      } satisfies AdminChatReply);
    }) },

    { method: 'GET', path: /^\/api\/admin\/documents\/([\w.-]+)$/, feature: FEATURE.OVERSIGHT, handle: multi(({ res, auth, params: [id] }) => {
      const doc = store.documents.get(id, ALL_USERS);
      if (!doc) return json(res, 404, { error: 'no such document' });
      audit('admin.view_document', { by: auth.userId, documentId: doc.id, chatId: doc.chat_id });
      return json(res, 200, { filename: doc.filename, mime: doc.mime, content: doc.content } satisfies DocumentTextReply);
    }) }
  ];
}
