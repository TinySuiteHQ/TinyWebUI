<div align="center">

# TinyWebUI

<a href="https://tinysuite.dev">
  <img src="assets/tinywebui-full-logo.png" alt="TinyWebUI" width="240" />
</a>

**A small, local-first chat workspace for any OpenAI-compatible model, with MCP tools.**

Part of [TinySuite](https://tinysuite.dev). Comes with [TinySearch](https://github.com/TinySuiteHQ/TinySearch) and [TinyContext](https://github.com/TinySuiteHQ/TinyContext) already connected.

[![Website](https://img.shields.io/badge/tinysuite.dev-home-000000?logo=googlechrome&logoColor=white)](https://tinysuite.dev)
[![npm version](https://img.shields.io/npm/v/tinywebui.svg)](https://www.npmjs.com/package/tinywebui)
[![npm downloads](https://img.shields.io/npm/dm/tinywebui.svg?label=downloads%2Fmonth)](https://www.npmjs.com/package/tinywebui)
[![Tests](https://github.com/TinySuiteHQ/TinyWebUI/actions/workflows/test.yml/badge.svg)](https://github.com/TinySuiteHQ/TinyWebUI/actions/workflows/test.yml)
[![License: AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)](LICENSE)
[![Node ≥ 22.13](https://img.shields.io/badge/node-%E2%89%A5%2022.13-339933.svg)](https://nodejs.org)
[![Release](https://img.shields.io/github/v/release/TinySuiteHQ/TinyWebUI?label=release)](https://github.com/TinySuiteHQ/TinyWebUI/releases)
[![Last Commit](https://img.shields.io/github/last-commit/TinySuiteHQ/TinyWebUI)](https://github.com/TinySuiteHQ/TinyWebUI/commits/main)
[![Discord](https://img.shields.io/badge/Discord-Join%20community-5865F2?logo=discord&logoColor=white)](https://discord.gg/mFFKF9bf5e)
![MCP Client](https://img.shields.io/badge/MCP-client-blue)

<img src="docs/demo.webp" width="760" alt="TinyWebUI in 30 seconds: npx tinywebui starts a fresh instance, the admin is created and a model endpoint connected, a question is answered with live web search, and a preference is saved to memory">

<sub>A real first run with DeepSeek V4.1 Flash through OpenRouter, sped up. <a href="https://tinysuite.dev/products/tinywebui/">Watch the full 100-second walkthrough</a>.</sub>

**[Read the documentation → tinysuite.dev/docs/tinywebui](https://tinysuite.dev/docs/tinywebui/)**

</div>

---

TinyWebUI is the chat interface of [TinySuite](https://tinysuite.dev), a set of small, local-first tools for AI agents. Bring an endpoint (OpenRouter, OpenAI, Groq, Ollama, vLLM, LM Studio, or anything else that speaks the OpenAI API), pick a model and a system prompt, and start working. Chats, documents and tool output stay in one SQLite file on your machine. There is no hosted backend and no account to create, and `npx tinywebui` needs no build step: the page ships prebuilt.

It comes pre-loaded with two TinySuite MCP servers, so a new install can already search the web and remember things:

- **[TinySearch](https://github.com/TinySuiteHQ/TinySearch)** searches, reads and reranks the web locally. It doesn't need a search API key.
- **[TinyContext](https://github.com/TinySuiteHQ/TinyContext)** is a local long-term memory that recalls only what fits the token budget.

## Highlights

- **Durable conversations.** Edit, retry, rewind, fork, full-text search, and folders with instructions of their own (a chat in a folder also searches only that folder's chats). A running turn belongs to the server, so you can reload and come back to it.
- **Steer a turn while it runs.** Press Enter to reach the model at the next safe point, or Alt+Enter to hold a follow-up.
- **MCP over stdio, Streamable HTTP or SSE.** Calls that can change something wait for your approval.
- **Attachments.** Text and source files, PDFs, DOCX and images.
- **Hybrid local search** (BM25 plus a small on-device embedding model) over documents and past chats.
- **Long chats that stay affordable.** Cache-friendly prefixes, one-time compaction of large tool results, and per-round token statistics.
- **Automations.** Cron-scheduled prompts that run in a chat of your choice.
- **Private by default.** The first account becomes the administrator; later local accounts come from a single-use invitation, or, with `access.allowRequests: true` (off by default), ask from the sign-in page and wait for an admin to approve them. Teams can alternatively put SSO in front.
- **Managed from files.** Version-controlled config that hot-reloads, refuses typos and has a fingerprint you can check against a running instance.
- **Themes.** Fall Fairy and Cyber Grid are included. See [theme authoring](web/public/themes/README.md) to write your own.

## Quick start

Requires **Node.js 22.13** or later. The bundled TinySearch and TinyContext servers also need **[uv](https://docs.astral.sh/uv/)**, which fetches them the first time they start. With sign-in on, each person gets their own memories and search history, and both keep their data in TinyWebUI's own folder ([docs/multi-user-mcp.md](docs/multi-user-mcp.md)).

```bash
npx tinywebui
```

Open <http://127.0.0.1:7777> and create the first account with a password of at least 10 characters. That account becomes the administrator and can invite others from Settings → People & roles, where requests for access from the sign-in page also wait for approval. Settings then opens on Models: add a connection (`connectors` in the config: any OpenAI-compatible URL, with an API key if it needs one), then the models people can pick from it. Every model, with its prompt, sampling and caching, belongs to a connection. The same in `tinywebui.config.json` (start from `example.tinywebui.config.json`):

```json
{
  "connectors": [
    {
      "id": "local",
      "baseUrl": "http://localhost:11434/v1",
      "models": [{ "id": "llama", "label": "Llama 3.2", "model": "llama3.2" }]
    }
  ]
}
```

A connector that needs a key takes `"apiKey": "${NAME}"`, filled in from the environment, or the key typed into Settings.

With accounts, a role decides what its people may use (features, models, what they may personalise) and, under Settings → People & roles, what their chats run with: its own prompt (which replaces the system prompt), default model, temperature, token and tool-turn limits, question timeout and tool approval. A value left blank keeps the global one. The prompt, temperature, token and tool-turn limits and tool approval can also be set for one model at a time, over the role's own. In the file these are `access.roles.<name>.settings` and `access.roles.<name>.modelSettings.<model id>`:

```json
{ "access": { "roles": { "student": { "features": ["chat"], "models": ["fast", "smart"],
  "settings": { "systemPrompt": "Explain step by step.", "model": "fast", "toolApproval": "all" },
  "modelSettings": { "smart": { "temperature": 0.2, "maxTokens": 2000 } } } } } }
```

`tinywebui.config.json` describes the deployment (endpoints, connectors, models, policy) and holds no secrets. A key is either a `${NAME}` reference, filled in from the environment, or kept in `tinywebui.secrets.json` beside it: what the Settings panel saves, and the generated session-signing secret. A key written straight into the config file moves there the next time the server starts. Accounts, password hashes and conversations live in `tinywebui.db`. TinyWebUI keeps the secrets file and the database readable by their owner only; keep them private and backed up.

`npx tinywebui` keeps the config, keys, database and embedding models in one folder per user: `~/Library/Application Support/TinyWebUI` on macOS, `%LOCALAPPDATA%\TinyWebUI` on Windows and `~/.local/share/tinywebui` (or `$XDG_DATA_HOME/tinywebui`) on Linux. Run it in a folder that has its own `tinywebui.config.json`, or pass `--config`, to use that instead. It uses keyword search until you run `npx tinywebui models pull fast` (about 90 MB) to enable hybrid search.

From a clone, run `npm install && npm start`. With Docker, start the service and create the administrator with an email address and password in the browser. The email is checked for valid format; TinyWebUI does not send mail or require a mail server for local accounts:

```bash
docker compose build
docker compose up -d
```

The Compose example publishes port 7777 on the host's loopback interface. Keep the data volume: it contains the accounts, conversations and local password hashes.

Since no mail is sent, there is no emailed reset. People change their own password under Settings → Account, and an admin can set a new one for anyone from Settings → People & roles. If the admin is the one locked out, run this on the server, where it prints a new password and signs that account out everywhere (`--stdin` reads the password instead):

```bash
node bin/tinywebui.ts users password owner@example.com                          # from a clone
docker compose exec tinywebui node bin/tinywebui.ts users password owner@example.com
```

 `npm start` and `npx tinywebui` default to multiuser setup. To run a local workspace without login, explicitly set `"authMode": "local"` in `tinywebui.config.json`; this mode binds only to loopback and has full access to settings and data, without account management. The runtime images contain Node.js but no npm/npx; connect MCP servers over HTTP or include their executables in a custom image.

The former password-only `single` mode now fails startup instead of opening without login. To move such an installation to local accounts, set `authMode` to `multiuser`, restart, and create the administrator in the browser. On that first setup, existing unowned chats, files, artifacts, folders and automations move to the new administrator. Remove any `TINYWEBUI_PASSWORD` environment variable; it no longer selects an auth mode.

## Documentation

The full reference lives at **[tinysuite.dev/docs/tinywebui](https://tinysuite.dev/docs/tinywebui/)**:

| Topic | Covers |
| --- | --- |
| [Quick start](https://tinysuite.dev/docs/tinywebui/#quick-start) | npx, clone, Docker |
| [Configuration](https://tinysuite.dev/docs/tinywebui/#configuration) | Environment variables, every setting, the model catalog |
| [MCP tools](https://tinysuite.dev/docs/tinywebui/#mcp-tools) | Adding servers, tool approval, built-in tools |
| [Chats and attachments](https://tinysuite.dev/docs/tinywebui/#chats-and-attachments) | Documents, images, steering a turn |
| [Search](https://tinysuite.dev/docs/tinywebui/#search) | Hybrid retrieval, embedding models, tuning |
| [Automations](https://tinysuite.dev/docs/tinywebui/#automations) | Scheduled prompts |
| [Long chats](https://tinysuite.dev/docs/tinywebui/#long-chats-caching-and-compaction) | Caching and compaction |
| [Usage statistics](https://tinysuite.dev/docs/tinywebui/#usage-statistics) | Token use and attribution |
| [Access](https://tinysuite.dev/docs/tinywebui/#access) | Local invited users, explicit local mode, or a team behind SSO |
| [Deployment as code](https://tinysuite.dev/docs/tinywebui/#deployment-as-code) | JavaScript config, locked settings, roles and features |
| [CLI](https://tinysuite.dev/docs/tinywebui/#cli) | Every command |
| [Security and limits](https://tinysuite.dev/docs/tinywebui/#security-and-limits) | Exposure, MCP trust, what isn't included |

In this repository: [docs/architecture.md](docs/architecture.md) is how the pieces fit, what the app survives and how its pages are laid out, [docs/deploy.md](docs/deploy.md) is a scripted container deployment, [docs/multi-user-mcp.md](docs/multi-user-mcp.md) covers sharing one TinySearch and TinyContext between many users, [docs/mcp-management.md](docs/mcp-management.md) is the contract any MCP server can implement to get a page on the MCP page, [docs/config.schema.json](docs/config.schema.json) is the config schema (also `tinywebui schema`), and [docs/performance.md](docs/performance.md) is what the page costs a browser, with the method to measure it again.

## Development

```bash
npm test        # type check (server and page), then the whole suite, about 15 seconds on a fast disk
npm run dev     # the API on :7777, restarting on changes in server/, bin/ and shared/
npm run dev:web # the page on :5173 with hot reload, proxying /api to :7777
```

The server is TypeScript that Node runs directly, with no build step, so working from a clone needs Node.js 22.18 or later. The page is Vue 3 and TypeScript in `web/`, built by Vite into `dist/`, which the server serves; `npm start` builds it first, and during development `npm run dev:web` serves it with hot reload instead. The npm package ships JavaScript compiled from the server and the built page (`npm run build`, which `npm pack` runs) and works from 22.13.

[AGENTS.md](AGENTS.md) maps the codebase and says where new code goes. `npm run eval` runs model-behaviour evals from `evals/tasks/` and makes real API calls, so it costs money.

## License

Copyright (C) 2026 MarcellM01

TinyWebUI is free software, released under the [GNU Affero General Public License v3.0 or later](LICENSE). It comes with no warranty. If you run a modified version for users over a network, you must offer them the corresponding source code for that version.
