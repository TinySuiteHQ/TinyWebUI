/**
 * The Integrations panel's API: every connected MCP server, and for those
 * that offer one (management.ts), its management views and actions.
 *
 * Who may see what is decided here, never by the server's manifest:
 *
 * - `instance` views (a server's own health, everyone's aggregate) are for
 *   admins in a multi-user deployment, and for the one person otherwise.
 * - `user` views show the caller's own data, so in a multi-user deployment
 *   they need the server to be bound to an identity (access/mcp_identity.ts):
 *   they are read on the caller's own connection, as the caller. On a server
 *   everyone shares there is no "own" data, only everyone's together: admins
 *   may open it (as they oversee the users anyway), anyone else sees the view
 *   listed but unavailable. Strict isolation, admins included, is an identity.
 * - Actions run the server's own tools with the same connection as the view,
 *   and a destructive one needs an explicit confirmation in the request.
 *
 * The browser never learns tool names or resource URIs; it names a server, a
 * view and an action by id, and gets back plain, bounded data.
 */

import { json, readJson, HttpError } from '../http.ts';
import { actor, type SignedIn } from '../access/auth_gate.ts';
import { audit } from '../audit.ts';
import { logger } from '../log.ts';
import { FEATURE } from '../../public/shared/features.js';
import {
  parseManifest, publicView, viewUri, detailUri, actionArgs, shapeViewData, shapeDetail, ManifestError,
  type Manifest, type View
} from '../management.ts';
import type { McpHub } from '../mcp.ts';
import type { Route, RouteContext, RouteDeps } from './types.ts';

const log = logger('integrations');

type As = { shared: true } | { userId: string | null };

// Manifests are re-read at most this often per server and caller: they can
// differ by caller, and change when a server restarts with other settings.
const MANIFEST_TTL_MS = 30_000;

const SHARED_HINT = 'This server is shared by everyone here, so it keeps everyone\'s data together: only an admin can open it. '
  + 'An admin can give it an identity to make it per-person.';
const SHARED_NOTE = 'This server is shared by everyone here: this is everyone\'s data, not only yours.';

/** A short, safe error text from a server: first line, bounded. */
const serverMessage = (err: unknown) => String((err as Error)?.message || err).split('\n')[0].slice(0, 300);

export function integrationsRoutes({ hub, multiUser }: Pick<RouteDeps, 'hub' | 'multiUser'>): Route[] {
  const cache = new WeakMap<McpHub, Map<string, { at: number; manifest: Manifest }>>();

  const asFor = (auth: SignedIn, scope: 'shared' | 'user'): As =>
    (scope === 'shared' ? { shared: true } : { userId: typeof auth.userId === 'string' ? auth.userId : null });

  async function manifestAs(server: string, as: As): Promise<Manifest> {
    const h = hub();
    let byKey = cache.get(h);
    if (!byKey) cache.set(h, byKey = new Map());
    const key = `${server}\n${'shared' in as ? '*' : as.userId ?? ''}`;
    const hit = byKey.get(key);
    if (hit && Date.now() - hit.at < MANIFEST_TTL_MS) return hit.manifest;
    const uri = h.manifests.get(server);
    if (!uri) throw new HttpError(404, 'this server has no management page');
    const manifest = parseManifest(await h.readResourceAs(server, uri, as), h.toolsOf(server));
    byKey.set(key, { at: Date.now(), manifest });
    return manifest;
  }

  /** Whether `auth` may open a view of this scope here, and if not, why. */
  function access(server: string, scope: View['scope'], auth: SignedIn): { as: As; reason?: undefined; note?: string } | { as?: undefined; reason: string } {
    const shared = !hub().isBound(server);
    if (scope === 'instance') {
      if (multiUser() && !auth.isAdmin) return { reason: 'admins only' };
      return { as: asFor(auth, 'shared') };
    }
    if (shared) {
      if (!multiUser()) return { as: asFor(auth, 'shared') };
      if (!auth.isAdmin) return { reason: SHARED_HINT };
      return { as: asFor(auth, 'shared'), note: SHARED_NOTE };
    }
    return { as: asFor(auth, 'user') };
  }

  /**
   * Every view `auth` may know about on one server, each read from the
   * manifest of the connection it would be opened on.
   */
  async function viewsFor(server: string, auth: SignedIn) {
    const wantInstance = !multiUser() || auth.isAdmin;
    const bound = hub().isBound(server);
    const out: { view: View; as?: As; reason?: string; note?: string }[] = [];
    let meta: Manifest | null = null;
    if (wantInstance || !bound) {
      const m = await manifestAs(server, { shared: true });
      meta = m;
      for (const view of m.views) {
        if (view.scope === 'instance' && !wantInstance) continue;
        if (view.scope === 'user' && bound) continue; // read from the user's own manifest below
        out.push({ view, ...access(server, view.scope, auth) });
      }
    }
    if (bound) {
      const m = await manifestAs(server, asFor(auth, 'user'));
      meta ??= m;
      for (const view of m.views) if (view.scope === 'user') out.push({ view, ...access(server, 'user', auth) });
    }
    return { meta: meta!, views: out };
  }

  /** One view, ready to read: or an HttpError saying why not. */
  async function openView(server: string, viewId: string, auth: SignedIn) {
    if (!hub().servers[server]) throw new HttpError(404, 'no such server');
    const { views } = await viewsFor(server, auth);
    const found = views.find((v) => v.view.id === viewId);
    if (!found) throw new HttpError(404, 'no such view');
    if (!found.as) throw new HttpError(403, found.reason!);
    return { view: found.view, as: found.as };
  }

  /** Runs a handler, turning manifest and server failures into clear statuses. */
  const guarded = (fn: (ctx: RouteContext<SignedIn>) => Promise<unknown>) =>
    async (ctx: RouteContext<SignedIn>) => {
      try { return await fn(ctx); } catch (err) {
        if (err instanceof HttpError) return json(ctx.res, err.status, { error: err.message });
        if (err instanceof ManifestError) return json(ctx.res, 400, { error: err.message });
        if (err instanceof SyntaxError) return json(ctx.res, 502, { error: 'the server answered with something that is not JSON' });
        return json(ctx.res, 502, { error: `the server could not answer: ${serverMessage(err)}` });
      }
    };

  const name = (raw: string) => decodeURIComponent(raw);
  const parseJson = (text: string) => JSON.parse(text.length > 2_000_000 ? '{}' : text);

  return [
    { method: 'GET', path: /^\/api\/integrations$/, feature: FEATURE.INTEGRATIONS, handle: async ({ res, auth }) => {
      const h = hub();
      const inventory = h.inventory([]).servers;
      const servers = await Promise.all(inventory.map(async (s) => {
        const bound = h.isBound(s.name);
        const row: Record<string, unknown> = {
          name: s.name,
          status: s.status,
          // Why a server failed can name hosts and commands: admins only.
          error: auth.isAdmin || !multiUser() ? s.error : null,
          perUser: bound,
          shared: multiUser() && !bound,
          tools: s.tools.length,
          managed: h.manifests.has(s.name) && s.status === 'ok',
          manifest: null
        };
        if (!row.managed) return row;
        try {
          const { meta, views } = await viewsFor(s.name, auth);
          row.manifest = {
            title: meta.title, description: meta.description, icon: meta.icon, version: meta.version,
            views: views.map(({ view, as, reason, note }) => ({ ...publicView(view), available: Boolean(as), reason: reason ?? null, note: note ?? null }))
          };
        } catch (err) {
          log.warn(`${s.name}: management manifest unavailable (${serverMessage(err)})`);
          row.manageError = err instanceof ManifestError ? `invalid manifest: ${err.message}` : 'the server did not answer';
        }
        return row;
      }));
      return json(res, 200, { multiUser: multiUser(), servers });
    } },

    { method: 'GET', path: /^\/api\/integrations\/([^/]+)\/views\/([^/]+)$/, feature: FEATURE.INTEGRATIONS,
      handle: guarded(async ({ res, url, auth, params: [server, viewId] }) => {
        const { view, as } = await openView(name(server), name(viewId), auth);
        const text = await hub().readResourceAs(name(server), viewUri(view, url.searchParams), as);
        return json(res, 200, shapeViewData(view, parseJson(text)));
      }) },

    { method: 'GET', path: /^\/api\/integrations\/([^/]+)\/views\/([^/]+)\/items\/([^/]+)$/, feature: FEATURE.INTEGRATIONS,
      handle: guarded(async ({ res, auth, params: [server, viewId, id] }) => {
        const { view, as } = await openView(name(server), name(viewId), auth);
        const text = await hub().readResourceAs(name(server), detailUri(view, name(id)), as);
        return json(res, 200, shapeDetail(view, parseJson(text)));
      }) },

    { method: 'POST', path: /^\/api\/integrations\/([^/]+)\/views\/([^/]+)\/actions\/([^/]+)$/, feature: FEATURE.INTEGRATIONS,
      handle: guarded(async ({ req, res, auth, params: [server, viewId, actionId] }) => {
        const body = await readJson(req);
        const { view, as } = await openView(name(server), name(viewId), auth);
        const action = view.actions.find((a) => a.id === name(actionId));
        if (!action) throw new HttpError(404, 'no such action');
        // Destructive means the person said yes to this exact action, not
        // that the browser happened to send the request.
        if (action.destructive && body.confirm !== true) return json(res, 400, { error: 'confirm_required', confirm: action.confirm });
        const args = actionArgs(action, action.target === 'row' ? body.row : null, body.input);
        const result = await hub().callToolAs(name(server), action.tool, args, as);
        // Who did what to which server; never the arguments, which are data.
        audit('integration.action', { by: actor(auth), server: name(server), view: view.id, action: action.id, ok: !result.isError });
        cache.get(hub())?.clear();
        const message = result.text.slice(0, 2000);
        if (result.isError) return json(res, 422, { ok: false, message, error: serverMessage(message) || 'the server refused' });
        return json(res, 200, { ok: true, message });
      }) }
  ];
}
