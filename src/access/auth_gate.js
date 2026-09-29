import { ALL_USERS } from '../store/index.js';
import { featuresFor } from './policy.js';
import { getSessionUser, resolveTrustedUser } from './auth.js';
import { audit } from '../audit.js';
import { FEATURE } from '../../public/shared/features.js';

/** The one account behind a 'single' password. */
export const OWNER_ID = 'owner';

// Reachable without a session: the login/OAuth dance itself, plus static
// assets so the login page can load before there's anyone to authenticate.
const PRE_AUTH_PATHS = /^\/api\/auth\//;
const isPreAuthPath = (pathname) => PRE_AUTH_PATHS.test(pathname) || !pathname.startsWith('/api/');

// In trusted-header mode the gateway owns login and logout; these two are
// the only /api/auth routes that exist, and both need the resolved user.
const TRUSTED_AUTH_PATHS = new Set(['/api/auth/me', '/api/auth/logout']);
// Still answered for a pending/disabled user, so the UI can say why.
const STATUS_EXEMPT_PATHS = TRUSTED_AUTH_PATHS;

function resolveIdentity(req, pathname, cfg, store) {
  if (cfg.authMode === 'none') return { userId: ALL_USERS, role: null, user: null, isAdmin: true };
  let user;
  if (cfg.authMode === 'trusted-header') {
    if (!pathname.startsWith('/api/')) return { userId: undefined, user: null, isAdmin: false };
    if (pathname.startsWith('/api/auth/') && !TRUSTED_AUTH_PATHS.has(pathname)) return { notFound: true };
    const result = resolveTrustedUser(req, store, cfg);
    if (result.reject) {
      audit('auth.rejected', { reason: result.reject, path: pathname });
      return { unauthorized: true };
    }
    user = result.user;
  } else {
    user = getSessionUser(req, store, cfg);
    if (!user) {
      if (!isPreAuthPath(pathname)) return { unauthorized: true };
      return { userId: undefined, user: null, isAdmin: false };
    }
  }
  if (!STATUS_EXEMPT_PATHS.has(pathname) && !(cfg.authMode !== 'trusted-header' && isPreAuthPath(pathname))) {
    if (user.status === 'disabled') return { disabled: true };
    if (user.status !== 'approved') return { pending: true };
  }
  // 'single': sessions hang off OWNER_ID but data stays unowned (ALL_USERS),
  // so switching between 'none' and 'single' never hides a chat.
  if (cfg.authMode === 'single') return { userId: ALL_USERS, role: 'admin', user, isAdmin: true };
  return { userId: user.id, role: user.role, user, isAdmin: user.role === 'admin' && user.status === 'approved' };
}

/**
 * The one auth gate for the whole handler. Fails closed: with auth on, a
 * request either resolves to a real user or carries `userId: undefined`,
 * which every scoped store method refuses. 'none' is a single-person
 * install and sees everything, exactly as before auth existed. A refusal
 * comes back as one of notFound / unauthorized / disabled / pending.
 */
export function resolveAuth(req, pathname, cfg, store) {
  const auth = resolveIdentity(req, pathname, cfg, store);
  // Features come from the policy for the caller's role; nobody signed in
  // gets none, which leaves only the routes the table marks open.
  auth.features = auth.userId !== undefined ? featuresFor(cfg, auth.role) : new Set();
  if (cfg.authMode === 'trusted-header' && auth.user) auth.isAdmin = auth.features.has(FEATURE.ADMIN);
  return auth;
}

/** Who to name in the audit log for a change: the user, or 'local' (tiers 1-2). */
export const actor = (auth) => (auth.user?.id && auth.user.id !== OWNER_ID ? auth.user.id : 'local');
