# TinyWebUI

A small, dependency-light chat UI for any OpenAI-compatible endpoint, with MCP tools. The server is strict TypeScript that Node runs as is (Node ≥ 22.18 to develop), so there is no build step for it in development; only the npm package is compiled, to JS that runs on Node ≥ 22.13. The page is Vue 3 + TypeScript in `web/`, compiled by Vite into `dist/`, which the server serves and the npm package ships prebuilt.

## Commands

- `npm test` — type check (`tsc` for the server, `vue-tsc` for the page via `web/typecheck.mjs`), then the whole suite, ~15 s (`node --test`, 30 s limit per test). Run it after every change. `npm run typecheck` is the first half alone.
- `npm run dev` + `npm run dev:web` — the API on :7777 (restarts on `server/`, `bin/`, `shared/` changes) and the page on http://127.0.0.1:5173 with hot reload, proxying `/api` to :7777. The server's CSP applies only to the built page, so check a page change once with `npm run build:web` too.
- `npm run build:web` — the page into `dist/` (gitignored). The server warns at startup, and `/` answers 503, while it is missing.
- `npm start` — builds the page, then the server on http://127.0.0.1:7777 with `tinywebui.config.json` and `tinywebui.db`. It first runs `models ensure`, which fetches the embedding model once; if that fails the server starts lexical (`TINYWEBUI_RETRIEVAL_MODE=lexical` skips it).
- `node bin/tinywebui.ts validate` — check the config; `--help` lists the other CLI commands.
- Trying the server by hand: point it at a copy of the database, never the real one —
  `TINYWEBUI_DB=<copy>.db node bin/tinywebui.ts --port 7790`. Opening a database migrates it.
- `npm run build` — the npm package's JS, emitted beside each `.ts`, and the page (`npm pack` runs it); `npm run clean` removes the JS. Never commit either.

## Layout

```
server/
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
shared/          imported by the server and the page (events, features, usage, origins,
                 settings value lists, attachment_note, declined); imports nothing
web/             the page: Vue 3 + TS, built by Vite (vite.config.ts) into dist/
  src/main.ts    creates the app
  src/app/       App.vue picks sign-in, waiting room or AppShell.vue, which is the only
                 wiring (it starts the stores)
  src/core/      api.ts (every JSON call), sse.ts (stream frames), md.ts (the only HTML
                 from outside text), id.ts
  src/model/     turn_model.ts: the transcript as data, a pure reducer over stream events
                 (history replays through it too); no Vue, no DOM
  src/stores/    Pinia: session (who, can()), config, chats (sidebar), chat (the open chat,
                 its run, queue, held input), attachments, panels (PANEL), ui, theme, admin
  src/chat/      ChatView.vue (the chat screen), Markdown.vue (also used by panels), and
                 sidebar/ (chat list, folders), transcript/ (turns, activity, approvals,
                 questions, outline), composer/ (input, menus, queue, attachments, tasks)
  src/panels/    one folder per panel (<name>/<Name>Panel.vue plus its parts);
                 usePanel.ts; settings/ also holds the settings draft and editors
  src/auth/      sign-in and the waiting room
  src/ui/        app-agnostic widgets: Icon, Modal, Popover, Switch
  src/styles/    base.css (tokens, layout, panels), chat.css (the transcript)
  public/        copied into dist/ as is: favicon, icons, themes/ (see its README)
test/            node:test suites; evals/ model-behaviour evals (costs API calls)
```

## Where things go

- **New API route:** add an entry to the matching `server/routes/*.ts`. Every entry declares `feature` (a `FEATURE.*` or `null`; the `Route` type will not compile without it); dispatch and permission are the same table, so there is no separate list to update. A route with a feature gets an `auth` whose `userId` is a scope. `readJson()` gives a JSON object whose fields are `unknown`: check each one (`typeof`, `oneOf()` from `http.ts`) before it goes anywhere typed. The factory's parameter list is its dependencies — add what it needs to `RouteDeps` in `routes/types.ts` and `routeTable()` in `server.ts` if it is new.
- **New query:** a method on the matching `server/store/<area>.ts`, called as `store.<area>.<method>()`, returning the area's row type (node:sqlite rows are untyped, so the result is cast once, there). An area that must touch another area's data calls that area (it is handed in by `store/index.ts`), never its tables.
- **New table or column:** `store/schema.ts` — add to `SCHEMA` or the `migrate()` steps, and bump `SCHEMA_VERSION` when an existing database needs changing. Add the column to the area's row type.
- **New secret setting** (a key, not shape): add it to `SECRET_KEYS` in `access/policy.ts` as well, so it is kept in the secrets file, redacted and fingerprinted only as set/unset.
- **New setting:** its default in `DEFAULTS` and its type in `Config` (`config/config.ts`); DEFAULTS is typed against Config, so the two cannot drift, and `node bin/tinywebui.ts schema > docs/config.schema.json` regenerates the schema (a test compares them). A setting that is a choice from a fixed list keeps its values in `shared/settings.ts`; the page's settings editor must label each one (`Record<T, string>` in `panels/settings/draft.ts`), so a new value will not compile until it has a label.
- **Text the server writes and the page recognises** (an attachment note, a declined call): one module in `shared/` that both writes and matches it, never a copy of the wording on either side.
- **New built-in tool:** a file in `server/tools/` exporting `xToolDef(): ToolDef` and `callX(args, deps)` (the contract is `tools/types.ts`), registered in `connectHub()` in `server.ts`, and its name added to `RESERVED` in `mcp.ts`.
- **New stream event:** add it to `shared/events.ts` and handle it in `HANDLERS` in `web/src/model/turn_model.ts` (typed against every event, so it will not compile until handled), with a case in `test/turn-model.test.ts` if it changes what is drawn. A stored history must replay to the same model as the live stream (`historyToEvents`).
- **New page code:** state that more than one component reads goes in a store (`web/src/stores/`), loaded by an action; components read the store and call its actions. Imports go one way: `app/` → `panels/` → `chat/` → `stores/` → `model/`, `core/` → `shared/`, `ui/` imports nothing of the app, and `model/` (the transcript reducer) imports only `shared/` (no Vue, no DOM). Stores do nothing on import: their `init()` is called from `app/AppShell.vue`. `test/page-structure.test.js` enforces this.
- **New panel:** a folder `web/src/panels/<name>/` whose `<Name>Panel.vue` root is `<section :id="name" :class="{ open: isOpen }">`, using `usePanel(PANEL.X, hooks)`; add the name to `PANEL` in `stores/panels.ts`, the component to `app/AppShell.vue` and its nav item to `chat/sidebar/Sidebar.vue`. Open or close it only through the panels store.
- **New API call from the page:** `api.get/post/patch/del` from `web/src/core/api.ts`; it throws on non-2xx with the server's `error` text and `.status`. Only the streaming endpoints use `fetch` directly (`stores/chat.ts`).
- **New feature flag:** `shared/features.ts`; the page asks `useSession().can(FEATURE.X)`.
- **New searchable corpus:** implement the `Corpus` adapter in `retrieval/retrieval.ts`, add its name to `CORPUS` in `store/embeddings.ts`, and `register()` it.

## Rules

- SQL lives only in `server/store/`. Nothing else touches `store.db`.
- `server/harness/` imports only its own files, `shared/` and `node:` (a test enforces it). What it needs from the app is passed in.
- The store imports nothing from the app (type-only imports of `harness/` wire shapes aside). Folder dependencies are one-way (e.g. `chat/` may use `tools/`, never the reverse); `server.ts` is the only place that wires everything.
- Identifiers shared across files are constants: `EVENT`, `FEATURE`, `CORPUS`. Don't write them as bare strings.
- Logs go through `logger(area)` from `log.ts` (`[tinywebui:<area>] ...`, level from `TINYWEBUI_LOG_LEVEL`). Security events go through `audit()` and are never filtered.
- `tinywebui.config.json` is the deployment's shape and never holds a secret: keys are `${NAME}` references or live in `tinywebui.secrets.json` (`config/secrets.ts`). The secrets file and the database are owner-only (0600).
- Every read of user-owned rows passes a scope (`Scope`: a user id, `null`, or `ALL_USERS`); `undefined` does not compile, and throws on purpose if it gets through anyway.
- Model-written text reaches the page as text (`{{ }}` interpolation) or through `chat/Markdown.vue`, whose `renderMarkdown` escapes first. `v-html` appears nowhere else (the sidebar's `markSnippet`, which escapes too, aside), and no `innerHTML` anywhere (a test enforces both).
- TS in, no build in dev: server code is `.ts` that Node strips and runs, so only erasable syntax (no `enum`, `namespace` or constructor parameter properties; `tsconfig.json` enforces it). Relative imports name the `.ts` file; type-only imports use `import type`. Types go on module boundaries: exports, factory parameters, row shapes. Outside JSON stays `unknown`/loose until it is checked; prefer narrowing to `!` and `as`, and say why when one is needed. `shared/` is the same kind of `.ts`, imported by both sides. The page (`web/`) is TS that Vite strips, checked by `vue-tsc` (on TypeScript 6, since vue-tsc needs the classic compiler API that TypeScript 7 dropped); the same erasable-syntax rule holds there. The page must work under the server's CSP (`script-src 'self'`, `style-src 'self'`, no `unsafe-*`): no runtime template compiler, no inline scripts or `style` attributes in markup (Vue `:style` bindings are fine).
- File names: modules are snake_case (`tool_executor.ts`, `turn_model.ts`), Vue components PascalCase (`ChatView.vue`), and tests are named in kebab-case after what they check (`page-structure.test.js`).
- Comments explain why, not what.
