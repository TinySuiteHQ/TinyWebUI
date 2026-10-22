import type { IncomingMessage } from 'node:http';
import { ALL_USERS, type Store } from '../store/index.ts';
import type { Scope } from '../store/scope.ts';
import type { UserRole, UserRow } from '../store/users.ts';
import type { Config } from '../config/config.ts';
import { featuresFor } from './policy.ts';
import { getSessionUser, resolveTrustedUser } from './auth.ts';
import { audit } from '../audit.ts';
import { FEATURE } from '../../public/shared/features.js';

/** Historical owner row removed when an old installation claims its first account. */
export const OWNER_ID = 'owner';

/**
 * Who is asking. `userId` is undefined when nobody is signed in, which every
 * scoped store method refuses; a refusal sets one of the four flags instead.
 */
export interface Auth {
  userId?: Scope;
  role?: UserRole | null;
  user?: UserRow | null;
  isAdmin?: boolean;
  notFound?: boolean;
  unauthorized?: boolean;
  disabled?: boolean;
  pending?: boolean;
  features: Set<string>;
}

/** An Auth past the gate of a route with a feature: someone holds it, so there is a scope. */
export type SignedIn = Auth & { userId: Scope };

// Reachable without a session: the login/OAuth dance itself, plus static
// assets so the login page can load before there's anyone to authenticate.
const PRE_AUTH_PATHS = /^\/api\/auth\//;
const isPreAuthPath = (pathname: string) => PRE_AUTH_PATHS.test(pathname) || !pathname.startsWith('/api/');

// In trusted-header mode the gateway owns login and logout; these two are
// the only /api/auth routes that exist, and both need the resolved user.
const TRUSTED_AUTH_PATHS = new Set(['/api/auth/me', '/api/auth/logout']);
// Still answered for a pending/disabled user, so the UI can say why.
const STATUS_EXEMPT_PATHS = TRUSTED_AUTH_PATHS;

function resolveIdentity(req: IncomingMessage, pathname: string, cfg: Config, store: Store): Omit<Auth, 'features'> {
  if (cfg.authMode === 'local') return { userId: ALL_USERS, role: null, user: null, isAdmin: true };
  let user: UserRow | null;
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
  return { userId: user.id, role: user.role, user, isAdmin: user.role === 'admin' && user.status === 'approved' };
}

/**
 * The one auth gate for the whole handler. Fails closed: with auth on, a
 * request either resolves to a real user or carries `userId: undefined`,
 * which every scoped store method refuses. 'local' is a single-person
 * install and sees everything, exactly as before auth existed. A refusal
 * comes back as one of notFound / unauthorized / disabled / pending.
 */
export function resolveAuth(req: IncomingMessage, pathname: string, cfg: Config, store: Store): Auth {
  const auth = resolveIdentity(req, pathname, cfg, store) as Auth;
  // Features come from the policy for the caller's role; nobody signed in
  // gets none, which leaves only the routes the table marks open.
  auth.features = auth.userId !== undefined ? featuresFor(cfg, auth.role) : new Set();
  if (cfg.authMode === 'trusted-header' && auth.user) auth.isAdmin = auth.features.has(FEATURE.ADMIN);
  return auth;
}

/** Who to name in the audit log for a change: the user, or 'local' (tiers 1-2). */
export const actor = (auth: Pick<Auth, 'user'>) => (auth.user?.id && auth.user.id !== OWNER_ID ? auth.user.id : 'local');
