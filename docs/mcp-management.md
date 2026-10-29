# Management pages for MCP servers (`tinysuite.manage/1`)

TinyWebUI's **Integrations** panel lists every connected MCP server. A server
can add a **Manage** page there: tables and stats about what it holds, plus
buttons that run its own tools. TinySearch and TinyContext use this, and any
other server can too. Implementing the contract below is enough: TinyWebUI
finds the page by itself, with no extra setting, adapter or second
connection.

The page is built from plain data. Your server never sends HTML or script.
TinyWebUI draws everything with its own components, as text.

## 1. Advertise a manifest

List one MCP resource with this media type:

```
mimeType: application/vnd.tinysuite.manage+json
```

The URI can be anything, e.g. `myserver://manage/manifest`. TinyWebUI looks
for it in `resources/list` when it connects, then reads it with
`resources/read` (one `text` content, JSON) whenever someone opens the panel.
Read the manifest per caller if what you offer depends on who is asking.

```json
{
  "contract": "tinysuite.manage/1",
  "id": "notes",
  "title": "Notes",
  "description": "Notes the assistant has kept for you.",
  "icon": "database",
  "version": "1.4.0",
  "views": [ ... ]
}
```

| Field | Rules |
| --- | --- |
| `contract` | Exactly `tinysuite.manage/1`. Any other value is refused. |
| `id` | `[a-z0-9][a-z0-9_-]{0,31}` |
| `title` | 1-80 characters |
| `description`, `version` | Optional, up to 300 and 40 characters |
| `icon` | One of `memory`, `search`, `database`, `globe`, `tool`, `plug`. Anything else shows as `plug`. |
| `views` | Up to 12 |

## 2. Views

Every view is read from one of your resources. Its URI is a template with a
single `{params}` segment, which carries the view's query.

```json
{
  "id": "notes",
  "title": "Notes",
  "kind": "table",
  "scope": "user",
  "resource": "notes://manage/views/notes/{params}",
  "pageSize": 50,
  "params": [
    { "name": "q", "label": "Search", "type": "text", "maxLength": 200 },
    { "name": "tag", "label": "Tag", "type": "enum", "values": ["work", "home"] }
  ],
  "columns": [
    { "key": "text", "label": "Note" },
    { "key": "created_at", "label": "Saved", "format": "datetime" }
  ],
  "rowKey": "id",
  "detail": { "resource": "notes://manage/items/{id}" },
  "actions": [ ... ]
}
```

- `kind` is `stats` (a grid of figures) or `table` (rows, search, paging,
  actions).
- `scope` decides who may open the view in TinyWebUI. See section 5.
- `params` (up to 8) are the filters shown above a table:
  - `text` takes free text up to `maxLength` characters (at most 500).
  - `enum` takes one of `values`.
  - `offset` and `limit` are reserved for paging.
- `{params}` becomes a percent-encoded querystring of the declared parameters
  plus `offset` and `limit`, or `-` when there are none. For example,
  `q=tea&offset=0&limit=50` arrives as `q%3Dtea%26offset%3D0%26limit%3D50`.
  Decode it, and reject names you do not know.
- `pageSize` is at most 100. TinyWebUI never asks for more.
- `columns` (up to 12) take a `format`: `text` (default), `multiline`,
  `number` or `datetime` (ISO 8601).
- `detail` is optional and needs `rowKey`. Its template has one `{id}`,
  which becomes the row's `rowKey` value, percent-encoded.

URIs must not use `http`, `https`, `file`, `data`, `javascript`, `ftp` or `ws`
schemes. TinyWebUI never fetches a URI from a manifest. It only reads your
resources over the MCP connection it already has.

### What a view resource returns

Stats:

```json
{ "items": [ { "label": "Notes", "value": 42 }, { "label": "Disk", "value": 1048576, "unit": "bytes", "hint": "..." } ],
  "notice": "optional one-line message, e.g. why there is no data" }
```

Table:

```json
{ "rows": [ { "id": "n1", "text": "...", "created_at": "2026-10-28T10:00:00Z" } ],
  "total": 120, "offset": 0, "limit": 50, "hasMore": true, "notice": null }
```

Detail:

```json
{ "fields": [ { "label": "Note", "value": "...", "format": "multiline" } ],
  "row": { "id": "n1", "text": "..." } }
```

Only scalar values reach the browser. Nested objects are dropped, and a row
keeps only the keys your columns, `rowKey` and actions use. Rows are capped
at 100, and strings at 20,000 characters, except a detail field in
`multiline` format, which may hold up to 200,000 (one row's long text, such
as everything a tool call returned).

## 3. Actions

An action runs **one of your own tools**: a tool you already list. TinyWebUI
refuses a manifest whose action names any other tool. Actions add no new
privileges; they reach whatever the tool reaches, as the caller.

```json
{ "id": "edit", "label": "Edit", "tool": "update_note",
  "input": { "label": "Note", "initial": "text", "maxLength": 20000, "multiline": true },
  "args": { "note_id": "$row.id", "text": "$input" } }
{ "id": "delete", "label": "Delete", "tool": "delete_note",
  "args": { "note_id": "$row.id" }, "destructive": true, "confirm": "Delete this note?" }
{ "id": "clear", "label": "Clear all", "tool": "clear_notes", "target": "view",
  "args": {}, "destructive": true, "confirm": "Delete every note?" }
```

- `target` is `row` (default: shown on a row's detail) or `view` (a button
  above the table).
- `args` values are constants (text, number, true/false), `$row.<key>` (the
  selected row's value) or `$input` (text the person typed into the `input`
  field).
- `destructive` actions are confirmed by the person. TinyWebUI's API refuses
  them without that confirmation.
- The row comes back from the browser, so treat `$row` values like any tool
  argument. Your tool must still apply the caller's identity: a forged id
  must find nothing.

## 4. Who is calling

Views and actions use the same MCP connection as the server's tools. If you
keep data per user, use the identity TinyWebUI sends on that connection
([multi-user-mcp.md](multi-user-mcp.md)), checked on every message. Never
take it from a parameter. TinyContext's hosted mode is a working example.

Make the page opt-in on your side, and authenticate it over HTTP.
TinySearch and TinyContext serve it only with `*_MANAGEMENT=on`. Over HTTP
they also need a trusted identity or a bearer token, and refuse to start
without one.

## 5. What TinyWebUI enforces

The manifest can only *narrow* access. It never grants anything.

| View scope | No-login install | Multi-user, server has `identity` | Multi-user, shared server |
| --- | --- | --- | --- |
| `user` | shown | shown, read as the caller on their own connection | listed, unavailable ("shared by everyone") |
| `instance` | shown | admins only, on the shared connection | admins only, on the shared connection |

- The Integrations panel only ever shows the caller's own data. An admin
  reaches another person's `user` views only from the Admin panel
  (**connectors** next to a user), on that person's own connection, so they
  see exactly what that person sees. It is read-only: no action is offered or
  accepted there. Every list, view and row opened is written to the audit log
  (`admin.view_user_integration`). A shared server has no one person's data,
  so it shows nothing there either. Your server needs nothing extra for this.
- Everything goes through TinyWebUI's server. The browser never sees your
  URIs, tool names or credentials, only a server name, a view id and an
  action id.
- State-changing requests carry TinyWebUI's cross-site protection. Every
  action is written to the audit log: who, which server, view and action,
  never the arguments.
- Reads time out after 10 seconds. If something goes wrong, that server's
  card shows a short message and the rest of the panel keeps working. This
  covers an invalid manifest, a server that is offline, and a view that
  fails.
- A server without a manifest is still listed, and its tools still work in
  chats.
