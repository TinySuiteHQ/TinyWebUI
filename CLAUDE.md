# TinyWebUI

A small, dependency-light chat UI for any OpenAI-compatible endpoint, with MCP tools. Node ≥ 22.13, ES modules, no build step, no framework. Solo project: commit straight to `main`.

## Commands

- `npm test` — whole suite, ~10 s (`node --test`, 30 s limit per test). Run it after every change.
- `npm start` — server on http://127.0.0.1:7777 with `tinywebui.config.json` and `tinywebui.db`.
- `node bin/tinywebui.js validate` — check the config; `--help` lists the other CLI commands.
- Trying the server by hand: point it at a copy of the database, never the real one —
  `TINYWEBUI_DB=<copy>.db node bin/tinywebui.js --port 7790`. Opening a database migrates it.

## Layout

```
src/
  server.js      wiring: builds `app`, the route table, reload and shutdown
  http.js        json(), readJson() + body limits, security headers, static files
  store/         the only module that talks to SQLite (see "Store" below)
  routes/        one file per API area, each a list of { method, path, feature, handle }
  chat/          the model turn: llm.js (loop, requests, retries), tool_executor.js,
                 runs.js (turns in flight + streaming), compact.js, agent.js, attribution.js
  tools/         built-in tools the model can call (read_document, search_chats, ask_user, ...)
  retrieval/     hybrid search engine (BM25 + embeddings, RRF) over any registered corpus
  access/        who is asking (auth_gate.js), sessions/passwords (auth.js), roles (policy.js)
  config/        config loading/saving (config.js), model catalog, tool-approval rules
  automations/   scheduled runs: automation.js (tool + cron), scheduler.js
  files/         turning uploads into text or wire-safe images
  mcp.js         MCP client hub; log.js; audit.js; cli.js; set-password.js
public/          the page (plain ES modules, no build); app.js is the entry and the only wiring
  core/        api.js (every JSON call), dom, state, md (renderMarkdown), access
  chat/        the conversation: chat, stream, transcript, composer, queue,
               attachments, sidebar, outline, tasks
  panels/      settings, MCP, automations, usage, admin; panels.js (PANEL, openPanel/closePanel)
  shared/      imported by the server too (events, features)
  themes/      optional themes, loaded by theme-loader.js
test/            node:test suites; evals/ model-behaviour evals (costs API calls)
```

## Where things go

- **New API route:** add an entry to the matching `src/routes/*.js`. Every entry declares `feature` (a `FEATURE.*` or `null`); dispatch and permission are the same table, so there is no separate list to update. The factory's parameter list is its dependencies — add what it needs to `routeTable()` in `server.js` if it is new.
- **New query:** a method on the matching `src/store/<area>.js`, called as `store.<area>.<method>()`. An area that must touch another area's data calls that area (it is handed in by `store/index.js`), never its tables.
- **New table or column:** `store/schema.js` — add to `SCHEMA` or the `migrate()` steps, and bump `SCHEMA_VERSION` when an existing database needs changing.
- **New built-in tool:** a file in `src/tools/` exporting `xToolDef()` and `callX()`, registered in `connectHub()` in `server.js`, and its name added to `RESERVED` in `mcp.js`.
- **New stream event:** add it to `public/shared/events.js` and handle it in `public/stream.js` (a test enforces this).
- **New page module:** in `core/`, `chat/` or `panels/`. Imports go one way: `panels/` → `chat/` → `core/`; `core/` imports only `shared/`. Nothing runs on import: listeners and timers go in an exported `init…()` called from `app.js`, and a call that would go against the arrows is passed in as a dependency there (`initSidebar({ openChat, newChat })`). `test/page-structure.test.js` enforces all of this.
- **New panel:** add it to `PANEL` and to `initPanels()` in `app.js`; open or close it only with `openPanel`/`closePanel`.
- **New API call from the page:** `api.get/post/patch/del` from `public/api.js`; it throws on non-2xx with the server's `error` text and `.status`. Only the streaming endpoints use `fetch` directly.
- **New feature flag:** `public/shared/features.js`.
- **New searchable corpus:** implement the adapter described at the top of `retrieval/retrieval.js`, add its name to `CORPUS` in `store/embeddings.js`, and `register()` it.

## Rules

- SQL lives only in `src/store/`. Nothing else touches `store.db`.
- The store imports nothing from the app. Folder dependencies are one-way (e.g. `chat/` may use `tools/`, never the reverse); `server.js` is the only place that wires everything.
- Identifiers shared across files are constants: `EVENT`, `FEATURE`, `CORPUS`. Don't write them as bare strings.
- Logs go through `logger(area)` from `log.js` (`[tinywebui:<area>] ...`, level from `TINYWEBUI_LOG_LEVEL`). Security events go through `audit()` and are never filtered.
- Every read of user-owned rows passes a scope (a user id, `null`, or `ALL_USERS`); `undefined` throws on purpose.
- Model-written text reaches the page as text (`textContent`) or through `renderMarkdown`, which escapes first. No other `innerHTML` with outside content.
- Comments explain why, not what.
