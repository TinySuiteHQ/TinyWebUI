# TinyWebUI

A small, dependency-light chat UI for any OpenAI-compatible endpoint, with MCP tools. ES modules, no framework. The server is strict TypeScript that Node runs as is (Node ≥ 22.18 to develop), so there is no build step in development; only the npm package is compiled, to JS that runs on Node ≥ 22.13. The page is plain JS.

## Commands

- `npm test` — type check (`tsc`), then the whole suite, ~10 s (`node --test`, 30 s limit per test). Run it after every change. `npm run typecheck` is the first half alone.
- `npm start` — server on http://127.0.0.1:7777 with `tinywebui.config.json` and `tinywebui.db`. It first runs `models ensure`, which fetches the embedding model once; if that fails the server starts lexical (`TINYWEBUI_RETRIEVAL_MODE=lexical` skips it).
- `node bin/tinywebui.ts validate` — check the config; `--help` lists the other CLI commands.
- Trying the server by hand: point it at a copy of the database, never the real one —
  `TINYWEBUI_DB=<copy>.db node bin/tinywebui.ts --port 7790`. Opening a database migrates it.
- `npm run build` — the npm package's JS, emitted beside each `.ts` (`npm pack` runs it); `npm run clean` removes it. Never commit it.

## Layout

```
src/
  server.ts      wiring: builds `app`, the route table, reload and shutdown
  http.ts        json(), readJson() + body limits, security headers, static files
  store/         the only module that talks to SQLite (see "Store" below)
  routes/        one file per API area, each a list of { method, path, feature, handle };
                 types.ts (Route, RouteDeps)
  harness/       model-facing core, imports nothing from the app: agent.ts (the loop),
                 provider.ts (request shape, caching, retries, SSE), prompt.ts (harness
                 rules, budget footer), history.ts (valid tool history), attribution.ts,
                 types.ts (messages, tool defs, request body: the wire shapes)
  chat/          a turn wired to the app: llm.ts (runChat: store, compaction, window),
                 tool_executor.ts, runs.ts (turns in flight + streaming), compact.ts
  tools/         built-in tools the model can call (read_document, search_chats, ask_user, ...);
                 types.ts (the tool contract)
  retrieval/     hybrid search engine (BM25 + embeddings, RRF) over any registered corpus
  access/        who is asking (auth_gate.ts), sessions/passwords (auth.ts), roles (policy.ts)
  config/        config loading/saving and the Config type (config.ts), model catalog,
                 tool-approval rules
  automations/   scheduled runs: automation.ts (tool + cron), scheduler.ts
  files/         turning uploads into text or wire-safe images
  mcp.ts         MCP client hub; mcp_serve.ts starts local servers over HTTP (serve);
                 log.ts; audit.ts; cli.ts
bin/tinywebui.ts the CLI entry
public/          the page (plain ES modules, no build); app.js is the entry and the only wiring
  core/        api.js (every JSON call), dom, state, id, md (the only HTML from outside text), access
  chat/        the conversation: chat, stream, transcript, composer, queue,
               attachments, sidebar, outline, tasks
  panels/      settings, MCP, automations, usage, admin; panels.js (PANEL, openPanel/closePanel)
  shared/      imported by the server too (events, features, usage); imports nothing
  themes/      optional themes, loaded by theme-loader.js
test/            node:test suites; evals/ model-behaviour evals (costs API calls)
```

## Where things go

- **New API route:** add an entry to the matching `src/routes/*.ts`. Every entry declares `feature` (a `FEATURE.*` or `null`; the `Route` type will not compile without it); dispatch and permission are the same table, so there is no separate list to update. A route with a feature gets an `auth` whose `userId` is a scope. `readJson()` gives a JSON object whose fields are `unknown`: check each one (`typeof`, `oneOf()` from `http.ts`) before it goes anywhere typed. The factory's parameter list is its dependencies — add what it needs to `RouteDeps` in `routes/types.ts` and `routeTable()` in `server.ts` if it is new.
- **New query:** a method on the matching `src/store/<area>.ts`, called as `store.<area>.<method>()`, returning the area's row type (node:sqlite rows are untyped, so the result is cast once, there). An area that must touch another area's data calls that area (it is handed in by `store/index.ts`), never its tables.
- **New table or column:** `store/schema.ts` — add to `SCHEMA` or the `migrate()` steps, and bump `SCHEMA_VERSION` when an existing database needs changing. Add the column to the area's row type.
- **New secret setting** (a key, not shape): add it to `SECRET_KEYS` in `access/policy.ts` as well, so it is kept in the secrets file, redacted and fingerprinted only as set/unset.
- **New setting:** its default in `DEFAULTS` and its type in `Config` (`config/config.ts`); DEFAULTS is typed against Config, so the two cannot drift, and `node bin/tinywebui.ts schema > docs/config.schema.json` regenerates the schema (a test compares them).
- **New built-in tool:** a file in `src/tools/` exporting `xToolDef(): ToolDef` and `callX(args, deps)` (the contract is `tools/types.ts`), registered in `connectHub()` in `server.ts`, and its name added to `RESERVED` in `mcp.ts`.
- **New stream event:** add it to `public/shared/events.js` and handle it in `public/chat/stream.js` (a test enforces this).
- **New page module:** in `core/`, `chat/` or `panels/`. Imports go one way: `panels/` → `chat/` → `core/`; `core/` imports only `shared/`. Nothing runs on import: listeners and timers go in an exported `init…()` called from `app.js`, and a call that would go against the arrows is passed in as a dependency there (`initSidebar({ openChat, newChat })`). `test/page-structure.test.js` enforces all of this.
- **New panel:** add it to `PANEL` and to `initPanels()` in `app.js`; open or close it only with `openPanel`/`closePanel`.
- **New API call from the page:** `api.get/post/patch/del` from `public/api.js`; it throws on non-2xx with the server's `error` text and `.status`. Only the streaming endpoints use `fetch` directly.
- **New feature flag:** `public/shared/features.js`.
- **New searchable corpus:** implement the `Corpus` adapter in `retrieval/retrieval.ts`, add its name to `CORPUS` in `store/embeddings.ts`, and `register()` it.

## Rules

- SQL lives only in `src/store/`. Nothing else touches `store.db`.
- `src/harness/` imports only its own files, `public/shared/` and `node:` (a test enforces it). What it needs from the app is passed in.
- The store imports nothing from the app (type-only imports of `harness/` wire shapes aside). Folder dependencies are one-way (e.g. `chat/` may use `tools/`, never the reverse); `server.ts` is the only place that wires everything.
- Identifiers shared across files are constants: `EVENT`, `FEATURE`, `CORPUS`. Don't write them as bare strings.
- Logs go through `logger(area)` from `log.ts` (`[tinywebui:<area>] ...`, level from `TINYWEBUI_LOG_LEVEL`). Security events go through `audit()` and are never filtered.
- `tinywebui.config.json` is the deployment's shape and never holds a secret: keys are `${NAME}` references or live in `tinywebui.secrets.json` (`config/secrets.ts`). The secrets file and the database are owner-only (0600).
- Every read of user-owned rows passes a scope (`Scope`: a user id, `null`, or `ALL_USERS`); `undefined` does not compile, and throws on purpose if it gets through anyway.
- Model-written text reaches the page as text (`textContent`) or through `renderMarkdown`, which escapes first. No other `innerHTML` with outside content.
- TS in, no build in dev: server code is `.ts` that Node strips and runs, so only erasable syntax (no `enum`, `namespace` or constructor parameter properties; `tsconfig.json` enforces it). Relative imports name the `.ts` file; type-only imports use `import type`. Types go on module boundaries: exports, factory parameters, row shapes. Outside JSON stays `unknown`/loose until it is checked; prefer narrowing to `!` and `as`, and say why when one is needed. `public/` stays JS (the browser loads it as is); `public/shared/`, which the server imports, carries JSDoc types and `// @ts-check`, so `tsc` checks it too.
- Comments explain why, not what.
