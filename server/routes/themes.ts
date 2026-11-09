import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { ServerResponse } from 'node:http';
import { json, readJson, PAGE_DIR } from '../http.ts';
import { ALL_USERS } from '../store/index.ts';
import { customizeFor } from '../access/policy.ts';
import { isSignedIn, type Auth } from '../access/auth_gate.ts';
import { audit } from '../audit.ts';
import type { Scope } from '../store/scope.ts';
import type { Route, RouteDeps } from './types.ts';

/** Bytes of CSS one imported theme may hold: a palette and some rules, not a stylesheet fork. */
export const THEME_CSS_LIMIT = 64 * 1024;
/** Themes one owner (a person, or "everyone") may keep. */
export const THEME_LIMIT = 50;
/** What an imported theme's rules are scoped under; the page sets it while one is on. */
export const CUSTOM_SCOPE = '[data-theme="custom"]';

// The built page's copy first (what is actually served); the source's when the
// page is not built, as in development and the tests.
const MANIFESTS = [
  join(PAGE_DIR, 'themes', 'manifest.json'),
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'public', 'themes', 'manifest.json')
];
const THEME_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The ids of the themes shipped in web/public/themes, read per call so a dropped-in folder counts without a restart. */
function builtInIds(): Set<string> {
  for (const file of MANIFESTS) {
    try {
      const themes: unknown = JSON.parse(readFileSync(file, 'utf8')).themes;
      return new Set(Array.isArray(themes) ? themes.map((t) => t?.id).filter((id) => typeof id === 'string') : []);
    } catch { /* not there: try the next */ }
  }
  return new Set();
}

/**
 * Why `css` cannot be imported as a theme, or null. The page's CSP already
 * refuses stylesheets and fonts from elsewhere; refusing them here too says
 * so at import instead of leaving a theme that silently half-loads.
 */
export function themeCssProblem(css: unknown): string | null {
  if (typeof css !== 'string' || !css.trim()) return 'the theme file is empty';
  if (Buffer.byteLength(css) > THEME_CSS_LIMIT) return `a theme may be at most ${THEME_CSS_LIMIT / 1024} KB`;
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  if (/@import\b/i.test(code)) return 'a theme cannot @import other stylesheets';
  if (/url\(\s*(?!['"]?\s*data:)/i.test(code)) return 'a theme cannot load files from elsewhere (only data: URLs)';
  // Without the scope, a rule loses to the dark palette's own selector, so
  // half the theme would apply. Start from the template and it is there.
  if (!code.includes(CUSTOM_SCOPE)) return `no rules under :root${CUSTOM_SCOPE}; start from the template`;
  return null;
}

export function themeRoutes({ config, multiUser, saveConfig, store }: Pick<RouteDeps, 'config' | 'multiUser' | 'saveConfig' | 'store'>): Route[] {
  // Signed in with sign-in on: theirs and everyone's. Sign-in off: one person, and everything is everyone's.
  const scopeOf = (auth: Auth): Scope => (multiUser() && auth.user ? auth.user.id : ALL_USERS);
  const mayChoose = (auth: Auth) => !multiUser() || customizeFor(config(), auth.role).includes('theme');
  // Themes for everyone: the admin's to add and remove; with sign-in off, the one person's.
  const mayShare = (auth: Auth) => !multiUser() || Boolean(auth.isAdmin);
  const signedIn = (auth: Auth) => isSignedIn(auth) && (!multiUser() || Boolean(auth.user));
  const refuse = (res: ServerResponse) => json(res, 401, { error: 'sign in first' });

  return [
    // Everything the Appearance section and the page's first paint need.
    { method: 'GET', path: /^\/api\/themes$/, feature: null, handle: ({ res, auth }) => {
      if (!signedIn(auth)) return refuse(res);
      const cfg = config();
      const choose = mayChoose(auth);
      const choice = multiUser() && auth.user && choose ? store.users.getPrefs(auth.user.id).theme ?? null : null;
      return json(res, 200, {
        default: cfg.theme || '',
        // null: follow the default. Sign-in off keeps the choice in the browser instead.
        choice,
        canChoose: choose,
        canShare: mayShare(auth),
        // Saving the default writes the config file, which a frozen deployment or a code pin forbids.
        multiUser: multiUser(),
        custom: store.themes.list(scopeOf(auth)).map((t) => ({ id: t.id, name: t.name, shared: t.user_id === null }))
      });
    } },

    { method: 'GET', path: /^\/api\/themes\/(t-[0-9a-f]{8})\.css$/, feature: null, handle: ({ res, auth, params: [id] }) => {
      if (!signedIn(auth)) return refuse(res);
      const theme = store.themes.get(id, scopeOf(auth));
      if (!theme) return json(res, 404, { error: 'no such theme' });
      res.writeHead(200, {
        'content-type': 'text/css; charset=utf-8',
        'content-length': Buffer.byteLength(theme.css),
        // An id is never reused for other CSS, so a browser may keep it; private, as it can be one person's.
        'cache-control': 'private, max-age=86400'
      });
      return res.end(theme.css);
    } },

    { method: 'POST', path: /^\/api\/themes$/, feature: null, handle: async ({ req, res, auth }) => {
      if (!signedIn(auth)) return refuse(res);
      const { name, css, shared } = await readJson(req, THEME_CSS_LIMIT * 2);
      const forEveryone = !multiUser() || shared === true;
      if (forEveryone ? !mayShare(auth) : !mayChoose(auth)) {
        return json(res, 403, { error: forEveryone ? 'only an admin can add a theme for everyone' : 'your administrator has not enabled choosing a theme' });
      }
      const label = typeof name === 'string' ? name.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
      if (!label || label.length > 60) return json(res, 400, { error: 'name must be 1-60 characters' });
      const problem = themeCssProblem(css);
      if (problem) return json(res, 400, { error: problem });
      // Sign-in on and not for everyone: mayChoose() passed, which only a signed-in user does.
      const owner = forEveryone ? null : auth.user!.id;
      if (store.themes.countOwned(owner) >= THEME_LIMIT) return json(res, 400, { error: `at most ${THEME_LIMIT} themes; delete one first` });
      // themeCssProblem() returned null, so css is a string.
      const theme = store.themes.add({ owner, name: label, css: css as string });
      if (forEveryone && multiUser()) audit('admin.theme_added', { by: auth.userId ?? null, id: theme.id });
      return json(res, 201, { id: theme.id, name: theme.name, shared: theme.user_id === null });
    } },

    { method: 'DELETE', path: /^\/api\/themes\/(t-[0-9a-f]{8})$/, feature: null, handle: ({ res, auth, params: [id] }) => {
      if (!signedIn(auth)) return refuse(res);
      const theme = store.themes.get(id, scopeOf(auth));
      if (!theme) return json(res, 404, { error: 'no such theme' });
      if (theme.user_id === null && !mayShare(auth)) return json(res, 403, { error: 'only an admin can delete a theme for everyone' });
      store.themes.remove(id);
      // The default must not name a theme that is gone: everyone falls back to the plain look.
      if (config().theme === id) saveConfig({ theme: '' }, auth.user?.id);
      if (theme.user_id === null && multiUser()) audit('admin.theme_removed', { by: auth.userId ?? null, id });
      return json(res, 200, { ok: true });
    } },

    // A person's own pick (sign-in on). null: follow the default; '' the plain look.
    { method: 'POST', path: /^\/api\/me\/theme$/, feature: null, handle: async ({ req, res, auth }) => {
      if (!signedIn(auth)) return refuse(res);
      if (!multiUser() || !auth.user) return json(res, 400, { error: 'with sign-in off the theme is kept in the browser' });
      if (!mayChoose(auth)) return json(res, 403, { error: 'your administrator has not enabled choosing a theme' });
      const { theme } = await readJson(req);
      if (theme !== null && theme !== '' && !(typeof theme === 'string' && THEME_ID.test(theme)
        && (builtInIds().has(theme) || store.themes.get(theme, auth.user.id)))) {
        return json(res, 400, { error: 'theme must be a theme you can see, "" or null' });
      }
      store.users.setPref(auth.user.id, 'theme', theme);
      return json(res, 200, { choice: theme });
    } }
  ];
}
