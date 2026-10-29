# Shared MCP servers for many users

One TinyWebUI, one TinySearch and one TinyContext can serve every user of a
multi-user deployment. No server runs per user. TinyContext keeps each user's
memories apart because TinyWebUI tells it, on every call, which signed-in user
the call is for.

## Out of the box

With no `mcp.json`, `npx tinywebui` already does all of this. With sign-in on
(`multiuser`, the default, or `trusted-header`), it starts TinySearch and
TinyContext itself over HTTP on a free loopback port, in their own multi-user
modes: TinyContext's hosted tenancy (one store per person) and TinySearch's
trusted identity (one history per person). Each person's calls go out on a
connection of their own, and every request carries a proxy token that
TinyWebUI makes fresh on each start, so nothing else on the machine can pose
as one of your users. TinyContext's tenant secret is generated once and kept
in `tinywebui.secrets.json`.

Their data, models and config live in TinyWebUI's own folder, under `mcp/`
(`%LOCALAPPDATA%\TinyWebUI` on Windows, `~/Library/Application Support/TinyWebUI`
on macOS, `~/.local/share/tinywebui` on Linux). TinySearch still records
nothing about what was searched unless `TINYSEARCH_ACTIVITY` is turned on.
With no sign-in (`local`) there is one person, and both run over stdio.

This is the `serve` setting on a `command` server, which you can use for any
server that follows the TinySuite convention (`MCP_TRANSPORT`, `MCP_HOST`,
`MCP_PORT`):

```json
"tinycontext": {
  "command": "uvx",
  "args": ["--python", "3.12", "--from", "tinysuite-context[server]>=0.5.4", "tinycontext"],
  "env": { "TINYCONTEXT_TENANCY": "proxy-header", "TINYCONTEXT_TRUSTED_PROXY_CIDRS": "127.0.0.1/32",
           "TINYCONTEXT_TENANT_STORE_DIR": "${TINYWEBUI_DATA_DIR}/mcp/tinycontext/tenants" },
  "serve": {
    "proxyToken": { "env": "TINYCONTEXT_TRUSTED_PROXY_TOKEN", "header": "X-TinyContext-Proxy-Token" },
    "managementToken": "TINYCONTEXT_MANAGEMENT_TOKEN",
    "secrets": ["TINYCONTEXT_TENANT_SECRET"]
  },
  "identity": { "header": "X-TinyContext-User-Id" }
}
```

- `proxyToken`: a new random token on every start, given to the server in
  `env` and sent by TinyWebUI as `header` on every request.
- `managementToken`: likewise new on every start, and sent only on the
  server-wide connection that reads the admin's instance views, never on a
  user's own.
- `secrets`: env vars that must stay the same across restarts, generated
  once and kept in the secrets file.
- `${TINYWEBUI_DATA_DIR}` is TinyWebUI's own data folder.

TinyWebUI stops the server when it stops or reloads MCP, and starts it again
on the next call if it exits. An `mcp.json` you already have is kept as it
is: delete it (or its TinySuite entries) to get these defaults.

## The setting

Give a remote server in `mcp.json` an `identity`:

```json
{
  "mcpServers": {
    "tinycontext": {
      "url": "http://tinycontext:8000/mcp",
      "headers": { "X-TinyContext-Proxy-Token": "${TINYCONTEXT_TRUSTED_PROXY_TOKEN}" },
      "identity": { "header": "X-TinyContext-User-Id", "claim": "id" }
    },
    "tinysearch": {
      "url": "http://tinysearch:8000/mcp",
      "headers": { "X-TinySearch-Proxy-Token": "${TINYSEARCH_TRUSTED_PROXY_TOKEN}" },
      "identity": { "header": "X-TinySearch-User-Id" }
    }
  }
}
```

- `header` is the request header that carries the user. TinyWebUI sets it.
  A server's static `headers` may not set the same header, and connection
  headers (`Authorization`, `Cookie`, `Mcp-Session-Id`, ...) cannot be used.
- The `*-Proxy-Token` header proves to the server that a request comes from
  TinyWebUI (see [the trust boundary](#the-trust-boundary)). Keep the token in
  `tinywebui.secrets.json` or the environment, never in `mcp.json` itself.
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

`identity` works only on HTTP servers: `url` ones, or `command` ones that
TinyWebUI starts over HTTP with `serve` (above). A stdio server is a single
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

To the MCP server, TinyWebUI acts as an authenticating proxy, so the server
must believe the user header only when TinyWebUI sent it. An address is not
enough for that: another container on the same network, or any local program
when the server listens on loopback, could otherwise name any user. Both
servers therefore need TinyWebUI's address *and* a shared proxy token on every
request:

```yaml
# TinyContext (compose.hosted.yaml)
TINYCONTEXT_TENANCY: proxy-header
TINYCONTEXT_TRUSTED_USER_HEADER: X-TinyContext-User-Id
TINYCONTEXT_TRUSTED_PROXY_CIDRS: 172.20.0.0/16   # the network TinyWebUI reaches it from
TINYCONTEXT_TRUSTED_PROXY_TOKEN: ${TINYCONTEXT_TRUSTED_PROXY_TOKEN}   # 32+ bytes

# TinySearch
TINYSEARCH_TRUSTED_USER_HEADER: X-TinySearch-User-Id
TINYSEARCH_TRUSTED_PROXY_CIDRS: 172.20.0.0/16
TINYSEARCH_TRUSTED_PROXY_TOKEN: ${TINYSEARCH_TRUSTED_PROXY_TOKEN}     # 32+ characters
```

TinyWebUI sends the tokens as static `headers` (see [the setting](#the-setting)).
Both servers check the peer address, the token and the user header on every
MCP message. TinyContext rejects a message without all three, and refuses to
start in hosted mode without a token. TinySearch treats it as a caller with no
identity: no history is kept for it and it reads no one's. Do not publish the
MCP servers' ports. Keep them on a private network that only TinyWebUI joins.
This needs TinyContext 0.5.4 and TinySearch 0.6.8 or later.

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
   `TINYCONTEXT_TRUSTED_PROXY_CIDRS` covering TinyWebUI's address there and a
   `TINYCONTEXT_TRUSTED_PROXY_TOKEN`.
3. Run TinySearch on the same network with `MCP_TRANSPORT=streamable-http`
   and the `TINYSEARCH_TRUSTED_*` settings above.
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
With `TINYSEARCH_ACTIVITY=content` instead of `history`, each entry in
**My searches** also opens to exactly what the model was shown (TinySearch
0.6.8 or later). An admin never sees another person's memories or searches there. To look
into one person's, an admin opens **Admin**, then **connectors** next to that
person. It is read-only, shows exactly what that person sees, and every view
opened is audited. See [mcp-management.md](mcp-management.md).

## Try it on one machine

`npx tinywebui` does this for you ([Out of the box](#out-of-the-box)). To
run the servers yourself instead, use three terminals, everything on
loopback, with TinyWebUI's own accounts standing in for a gateway:

```bash
# 1. TinyContext: one store per user, management views on
export TINYCONTEXT_MANAGEMENT_TOKEN=$(openssl rand -hex 20)
export TINYCONTEXT_TRUSTED_PROXY_TOKEN=$(openssl rand -hex 32)
TINYCONTEXT_TENANCY=proxy-header TINYCONTEXT_TENANT_STORE_DIR=./tenants \
TINYCONTEXT_TENANT_SECRET=$(openssl rand -hex 32) TINYCONTEXT_TRUSTED_PROXY_CIDRS=127.0.0.1/32 \
TINYCONTEXT_MANAGEMENT=on MCP_TRANSPORT=streamable-http MCP_PORT=8101 \
uvx --from 'tinysuite-context[server]>=0.5.4' tinycontext

# 2. TinySearch: shared, each person's own history kept for 7 days
export TINYSEARCH_MANAGEMENT_TOKEN=$(openssl rand -hex 20)
export TINYSEARCH_TRUSTED_PROXY_TOKEN=$(openssl rand -hex 32)
TINYSEARCH_MANAGEMENT=on TINYSEARCH_ACTIVITY=history \
TINYSEARCH_TRUSTED_USER_HEADER=X-TinySearch-User-Id TINYSEARCH_TRUSTED_PROXY_CIDRS=127.0.0.1/32 \
MCP_TRANSPORT=streamable-http MCP_PORT=8102 \
uvx --from 'tinysuite-search[server]>=0.6.8' tinysearch

# 3. TinyWebUI (authMode multiuser: the first sign-up is the admin, who invites the rest)
npx tinywebui
```

Give TinyWebUI the same four tokens in its environment, and this `mcp.json`.
On loopback the proxy tokens are what keep other programs on the machine
from posing as one of your users:

```json
{
  "mcpServers": {
    "tinycontext": { "url": "http://127.0.0.1:8101/mcp",
      "headers": { "Authorization": "Bearer ${TINYCONTEXT_MANAGEMENT_TOKEN}",
                   "X-TinyContext-Proxy-Token": "${TINYCONTEXT_TRUSTED_PROXY_TOKEN}" },
      "identity": { "header": "X-TinyContext-User-Id" } },
    "tinysearch": { "url": "http://127.0.0.1:8102/mcp",
      "headers": { "Authorization": "Bearer ${TINYSEARCH_MANAGEMENT_TOKEN}",
                   "X-TinySearch-Proxy-Token": "${TINYSEARCH_TRUSTED_PROXY_TOKEN}" },
      "identity": { "header": "X-TinySearch-User-Id" } }
  }
}
```

Sign in as two people in two browsers. Each one saves a memory and runs a
search, then opens **Integrations**. Each sees only their own memories and
searches. The admin also sees TinySearch's Overview, Domains and Blocking
rules, and TinyContext's Service view.
