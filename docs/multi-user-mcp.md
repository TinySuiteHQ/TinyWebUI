# Shared MCP servers for many users

One TinyWebUI, one TinySearch and one TinyContext can serve every user of a
multi-user deployment. No server runs per user. TinyContext keeps each user's
memories apart because TinyWebUI tells it, on every call, which signed-in user
the call is for.

## The setting

Give a remote server in `mcp.json` an `identity`:

```json
{
  "mcpServers": {
    "tinycontext": {
      "url": "http://tinycontext:8000/mcp",
      "identity": { "header": "X-TinyContext-User-Id", "claim": "id" }
    },
    "tinysearch": {
      "url": "http://tinysearch:8000/mcp",
      "identity": { "header": "X-TinySearch-User-Id" }
    }
  }
}
```

- `header` is the request header that carries the user. TinyWebUI sets it.
  A server's static `headers` may not set the same header, and connection
  headers (`Authorization`, `Cookie`, `Mcp-Session-Id`, ...) cannot be used.
- `claim` says which value of the user the header carries:
  - `id` (default) is TinyWebUI's own user id: stable, and never reused.
  - `externalId` is the id the SSO gateway sent (`trusted-header` mode).
    Choose it if you replace another front end that already keyed user data by
    that id.
  - `email` is the user's email. Choose it only if the gateway vouches for
    emails, and only to keep data that is already stored by email.

A call goes out only if the user exists, is approved, and has that claim.
Otherwise it is refused and never sent as somebody else. In a no-login
install (`authMode: 'local'`) everyone is the one person, `local`.

`identity` works only on `url` servers. A `command` (stdio) server is a single
process, and every user of a multi-user deployment shares it, including
whatever data it keeps.

`tinywebui validate` checks these rules. A server with an invalid `identity`
is not connected at all, rather than connected without it.

## What happens per call

- **Who the user is.** The identity comes from the chat the turn runs in: its
  owner, read from TinyWebUI's database. It never comes from the browser, the
  model's tool arguments, or anything the MCP server sends. Automations run as
  the owner of their chat.
- **Each user has their own connection.** Every user gets a separate MCP
  connection to a bound server, opened on first use with their header. The
  header never changes on a connection, and no two users share one. Two
  concurrent turns therefore have no header to race on, and server-side MCP
  session state (TinySearch's browser, for one) is never shared.
  - A connection closes after 10 minutes unused. A server keeps at most 200;
    when a server is full, the least recently used connection closes first.
  - A connection the server dropped is replaced on the next call. A call that
    the server says never ran (its session was gone) is sent again once.
    Otherwise, only read-only, idempotent calls are repeated.
- **Listing a server's tools** uses one shared connection that identifies as
  `urn:tinywebui:discovery`. That connection never carries a user's call.

## The trust boundary

To the MCP server, TinyWebUI acts as an authenticating proxy: the server
believes the header because only TinyWebUI can reach it. So the server must
accept that header only from TinyWebUI's address. TinyContext does this in its
hosted mode:

```yaml
# TinyContext (compose.hosted.yaml)
TINYCONTEXT_TENANCY: proxy-header
TINYCONTEXT_TRUSTED_USER_HEADER: X-TinyContext-User-Id
TINYCONTEXT_TRUSTED_PROXY_CIDRS: 172.20.0.0/16   # the network TinyWebUI reaches it from
```

TinyContext checks the peer address and the header on every MCP message, and
rejects any message without both. Do not publish the MCP servers' ports. Keep
them on a private network that only TinyWebUI joins.

## An example deployment

```
browser ─▶ SSO gateway (Cloudflare Access, oauth2-proxy, Authelia, ...)
              │  signs the user in, sends x-tinysuite-user-id / -email
              ▼
          TinyWebUI  authMode: 'trusted-header', trustedProxyCidrs: [gateway]
              │  private network "tinysuite"; identity header set per user
              ├─▶ TinyContext  hosted tenancy, trusted CIDR = TinyWebUI
              └─▶ TinySearch   shared, per-connection browser sessions
```

1. Put TinyWebUI behind the gateway, as in [Access](https://tinysuite.dev/docs/tinywebui/#access).
   Only the gateway may reach TinyWebUI, and only TinyWebUI may reach the MCP
   servers.
2. Run TinyContext from its `compose.hosted.yaml` on the private network, with
   `TINYCONTEXT_TRUSTED_PROXY_CIDRS` covering TinyWebUI's address there.
3. Run TinySearch on the same network with `MCP_TRANSPORT=streamable-http`.
4. Add both to `mcp.json` with `identity` as above, then run `tinywebui validate`.

To check isolation, sign in as two users and ask each one to save a memory.
Each user's `list_memories` shows only their own.

## Management pages

With `TINYCONTEXT_MANAGEMENT=on` and `TINYSEARCH_MANAGEMENT=on`, the
**Integrations** panel shows each person their own memories and search
history. It reads them on that person's own connection, under the same
identity as their chats. An admin also sees the servers' instance-wide views
(TinySearch's domains and health, TinyContext's store count) when the server
is given a management token, e.g.
`"headers": { "Authorization": "Bearer ${TINYSEARCH_MANAGEMENT_TOKEN}" }`.
An admin never sees another person's memories or searches there. See
[mcp-management.md](mcp-management.md).
