# Note: admin access to connector data (in progress)

Branch `integrations-admin-access`, paused 2026-10-29. Not pushed.

## Goal

In a multi-user deployment: regular users see only their own memories and
searches from a connector, admins see everyone's. Strict isolation (admins
included) stays opt-in.

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
- On a connector with an identity, an admin today sees only the server's
  `instance` views (whatever overview its management page offers) and their
  own `user` views.

## Done on this branch

Commit `8aaa229`: admins can open a shared (no-identity) connector's `user`
views, with a note that the data is everyone's. Regular users still see the
view listed but unavailable.

- `src/routes/integrations.ts`: `access()`, `SHARED_HINT`, `SHARED_NOTE`
- `public/panels/integrations.js`: shows the note above the view
- `test/integrations.test.js`: alice is refused, the admin gets everyone's rows

## Proposed next: "view as user"

For connectors with an identity:

- An admin picks a user in the Integrations panel; the view and its actions run
  on that user's own connection (`readResourceAs` / `callToolAs` with that
  user's id), showing exactly what that user would see.
- Only admins may pick a user; the server ignores the choice from anyone else.
- Every read and action is audited as "admin X as user Y".
- Needs no changes on the MCP server's side.

## Open questions

1. Build "view as user"?
2. Keep or revert commit `8aaa229`?
