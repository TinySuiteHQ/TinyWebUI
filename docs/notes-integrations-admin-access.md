# Note: admin access to connector data (in progress)

Branch `integrations-admin-access`, 2026-10-29.

## Rules (decided)

- A user can never reach another user's connector data.
- An admin can, read-only, and only through the Admin panel (as with chats).
  Every read is audited.
- The Integrations panel is always the caller's own data, admins included.

## What we found

- `authMode` defaults to `multiuser` (`DEFAULTS` in `src/config/config.ts`), so
  `npx tinywebui` is multi-user even for one person. That is why the
  Integrations panel showed "This server is shared by everyone here...".
- A connector without `identity` does not separate users. Chat tool calls go
  through `clientFor(server, userId)` in `src/mcp.ts`, which ignores `userId` for
  such a connector and returns the one shared connection. Nothing on it (no
  header, argument or metadata) tells the MCP server who is calling, so every
  user's data lands in one store and any user's chat can query all of it.
- Per-user separation needs `identity` on the connector (remote `url` servers
  only): each user gets their own connection carrying their id.

## Done

- Commit `8aaa229` (admins open a shared connector's `user` views in the
  Integrations panel, actions included) is reverted: it broke the last two rules.
- Oversight of connectors, in `src/routes/integrations.ts`:
  `GET /api/admin/users/<id>/integrations`, `.../<server>/views/<view>` and
  `.../items/<item>`, behind `FEATURE.OVERSIGHT`. Read on the user's own
  connection; views are sent without actions and there is no action route.
  Audited as `admin.view_user_integrations` / `admin.view_user_integration`.
  A shared connector is listed with no views. A user who is not approved has no
  connection to read (409).
- Admin panel: **connectors** next to **chats** on each user. Nothing is read
  until a view is picked. `showView()` in `public/panels/integrations.js` now
  carries its own state, so both panels draw views with it.
- Tests in `test/integrations.test.js`; docs in `mcp-management.md` and
  `multi-user-mcp.md`.

## Separation belongs to the products

TinyContext (hosted tenancy) and TinySearch (`history` mode) separate users
themselves; TinyWebUI only acts as their trusted proxy. Both trusted the user
header on the caller's address alone, so anything else that could send from
that network could name any user. Fixed in the products (uncommitted, both on
`main`): `TINYCONTEXT_TRUSTED_PROXY_TOKEN` / `TINYSEARCH_TRUSTED_PROXY_TOKEN`,
sent as `X-TinyContext-Proxy-Token` / `X-TinySearch-Proxy-Token` on every
request, checked per message alongside the address, required when the user
header is configured. Stdio is untouched. `multi-user-mcp.md` assumes the next
patch releases, TinyContext 0.5.3 and TinySearch 0.6.8.

Also in TinySearch (uncommitted): `TINYSEARCH_ACTIVITY=content` keeps, per
caller, the exact text each search, fetch and browser action returned to the
model (sized by the tools' own limits, no second cap), shown when an entry in
"My searches" is opened. `browser_storage_state_path` is now one file per
caller on a server that tells callers apart; the shared page fetcher and
callers without an identity load none. TinyWebUI shows `multiline` detail
fields up to 200,000 characters (`LIMITS.detailText`) so that text arrives
whole.

## Next

- Release both products, then confirm the versions in `multi-user-mcp.md`.
- `npx tinywebui` in multiuser mode: launch TinyContext and TinySearch as local
  HTTP servers in their own multi-user modes (loopback, generated proxy token
  and tenant secret, `identity` on each) instead of stdio, so users are
  separate by default. TinyWebUI's part is process handling only.
- Not yet tried in a browser.
