# Deploying TinyWebUI from scripts

This walkthrough deploys a complete tier-3 instance (team sign-in through a gateway, per-role features, fixed models and MCP servers) with no browser setup. Every step is a command, so an agent or a CI job can run it.

## 1. Files

```
deploy/
  config/
    tinywebui.config.js   # the deployment, committed
    mcp.json              # only if MCP servers aren't in the JS file
  compose.yaml
  .env                    # secrets, NOT committed
```

**`config/tinywebui.config.js`** holds no secrets and is safe to commit:

```js
export default {
  config: {
    authMode: 'trusted-header',
    trustedProxyCidrs: ['172.30.0.0/24'],         // the gateway's network (see compose.yaml)
    logoutUrl: 'https://team.cloudflareaccess.com/cdn-cgi/access/logout',

    baseUrl: 'http://model-gateway:8080/v1',      // any OpenAI-compatible endpoint
    apiKey: process.env.MODEL_API_KEY,            // from the environment, never the file
    model: 'fast',
    systemPrompt: 'You are the team assistant. Be brief and cite sources.',
    toolApproval: 'writes',

    frozen: true,                                 // nothing changes from the UI
    autoMigrate: false,                           // migrations are their own step (below)

    access: {
      bootstrapAdmins: ['google-oauth2|1234567890'],
      newUsers: 'pending',
      roles: {
        user:  { features: ['chat', 'attachments', 'images', 'search', 'folders', 'model-picker'], models: ['fast', 'smart'] },
        admin: { features: '*' }
      }
    }
  },
  mcpServers: {
    search: { url: 'http://tinysearch:8000/mcp' }
  },
  // Admin decisions (approvals, bans) are written back here. Keep it on
  // the data volume so they survive redeploys.
  configFile: '/data/tinywebui.config.json',
};
```

Secrets come from the environment:

| Variable | What it is |
| --- | --- |
| `MODEL_API_KEY` | read by the config above (any name works; it is plain JS) |
| `TINYWEBUI_SESSION_SECRET` | signs session cookies; set it so restarts keep sessions (tier 2) |
| `TINYWEBUI_PASSWORD` | tier 2 only: the password, when not using `set-password` |
| `TINYWEBUI_API_KEY` | alternative to `apiKey` for JSON-only configs |

**`compose.yaml`**:

```yaml
services:
  tinywebui:
    image: tinywebui:0.1.0            # pin a tag or digest
    build: ../                        # or build from a checkout
    read_only: true
    env_file: .env
    volumes:
      - ./config:/config:ro
      - tinywebui-data:/data
    networks:
      gateway: { ipv4_address: 172.30.0.10 }
    # No published port: only the gateway reaches TinyWebUI.

  gateway:
    image: your-sign-in-gateway       # Cloudflare Access tunnel, oauth2-proxy, Authelia, ...
    networks:
      gateway: { ipv4_address: 172.30.0.2 }
    # It must strip incoming X-TinySuite-* headers and set them from the
    # verified identity, then proxy to http://172.30.0.10:7777.

volumes:
  tinywebui-data:

networks:
  gateway:
    ipam: { config: [{ subnet: 172.30.0.0/24 }] }
```

## 2. Validate before deploying

```bash
docker compose run --rm tinywebui validate
# ok 3f1c9a0e5b7d2c41      <- the fingerprint of this exact config
```

A non-zero exit lists every problem (unknown keys, bad values, missing proxy list, invalid access policy, bad `mcp.json`). Run this in CI on every config change.

## 3. Migrate the database

```bash
docker compose run --rm tinywebui migrate --check   # exit 1 when a migration is due
docker compose run --rm tinywebui migrate           # applies it; safe to repeat
```

With `autoMigrate: false`, the server refuses to start on a database that is behind, so an upgrade can never migrate your data by surprise.

## 4. Check dependencies

```bash
docker compose run --rm tinywebui doctor
{"check":"node","ok":true,"detail":"22.20.0"}
{"check":"config","ok":true,"detail":"fingerprint 3f1c9a0e5b7d2c41"}
{"check":"database","ok":true,"detail":"/data/tinywebui.db at schema 2"}
{"check":"model endpoint","ok":true,"detail":"http://model-gateway:8080/v1 answered 200"}
{"check":"mcp search","ok":true,"detail":"4 tool(s)"}
```

One JSON line per check; exit 1 if any fail.

## 5. Start and verify

```bash
docker compose up -d
```

The image's health check calls `/readyz`. From inside the network (or with `docker compose exec`), verify that what runs is what you validated:

```bash
docker compose exec tinywebui node -e \
  "fetch('http://127.0.0.1:7777/readyz').then(r=>r.json()).then(console.log)"
# { ready: true, version: '0.1.0', fingerprint: '3f1c9a0e5b7d2c41' }
```

The fingerprint matches step 2. It covers every setting and MCP server; secret values never enter it.

| Endpoint | Auth | Returns |
| --- | --- | --- |
| `GET /healthz` | none | `{ ok: true }` while the process answers |
| `GET /readyz` | none | 200 when the database is reachable, with `version` and `fingerprint`; 503 otherwise |
| `GET /api/meta` | signed in | version, schema version, fingerprint, config mode, auth mode, MCP server names |

## 6. Operate

- **Change the deployment:** edit `tinywebui.config.js`, run `validate`, then `docker compose up -d` (a restart). Edits to `/data/tinywebui.config.json` or `mcp.json` reload live, or on `docker compose kill -s HUP tinywebui`.
- **Users from scripts:** `docker compose exec tinywebui node bin/tinywebui.js users set 'google-oauth2|42' --status approved` records the decision in `/data/tinywebui.config.json`, and the running server applies it.
- **See what a role gets:** `docker compose run --rm tinywebui config show --role user`.
- **Audit:** every change and admin action is a `[tinywebui:audit]` JSON line in `docker compose logs tinywebui`.
- **Stop:** `SIGTERM` (what `docker compose stop` sends) closes MCP connections and the database cleanly.

Same config, same image and same data volume produce the same control-plane state after every restart. Admin decisions live in the data volume's config file, and everything else is in the committed files.
