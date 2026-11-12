# TinyWebUI

A small, dependency-light chat UI for any OpenAI-compatible endpoint, with MCP tools. The server is strict TypeScript that Node runs as is (Node ≥ 22.18 to develop), so there is no build step for it in development; only the npm package is compiled, to JS that runs on Node ≥ 22.13. The page is Vue 3 + TypeScript in `web/`, compiled by Vite into `dist/`, which the server serves and the npm package ships prebuilt.

[docs/architecture.md](docs/architecture.md) explains how the pieces fit, what the app survives, and why the pages look the way they do.
## Commands

- `npm test` — type check (`tsc` for the server, `vue-tsc` for the page via `web/typecheck.mjs`), then the whole suite, ~15 s on a fast disk (`node --test`, 120 s limit per test, which counts a whole file run in its own process: the files that start servers can need it on a slow disk such as WSL's `/mnt/c`). Run it after every change. `npm run typecheck` is the first half alone.
- `npm run dev` + `npm run dev:web` — the API on :7777 (restarts on `server/`, `bin/`, `shared/` changes) and the page on http://127.0.0.1:5173 with hot reload, proxying `/api` to :7777. The server's CSP applies only to the built page, so check a page change once with `npm run build:web` too.
- `npm run test:layout` — after `npm run build:web`: the app in Chrome (`playwright-core` drives the installed one, `$CHROME_PATH`, or its own headless shell from `npx playwright-core install chromium-headless-shell`, which is what works in WSL) at phone, editor-pane, tablet and laptop sizes, every page, menu and dialog, failing on overflow and spills; screenshots in `layout/out/`. `--size 783x508` and `--state files` narrow it. Run it before shipping a page change; it is not part of `npm test`.
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
  transfer/      export and import: backup.ts (the backup file, its checks, import that
                 never overwrites), markdown.ts (a chat as a readable transcript)
  mcp.ts         MCP client hub; mcp_serve.ts starts local servers over HTTP (serve);
                 log.ts; audit.ts; cli.ts
bin/tinywebui.ts the CLI entry
shared/          imported by the server and the page (events, features, usage, origins,
                 settings value lists, attachment_note, declined, api: typed reply shapes);
                 imports nothing
web/             the page: Vue 3 + TS, built by Vite (vite.config.ts) into dist/
  src/main.ts    creates the app
  src/app/       App.vue picks sign-in, waiting room or AppShell.vue, which is the only
                 wiring (it starts the stores, and holds the Files and MCP pages);
                 SettingsDialog.vue holds the settings sections, grouped: You (account,
                 appearance, automations, usage, data) and Workspace (models, model defaults,
                 chat behaviour, people & roles); lazy.ts: every page behind the chat
                 is its own chunk, fetched on first open or once the browser is idle,
                 and mounted only once opened (the panels store's `seen`)
  src/core/      api.ts (every JSON call), sse.ts (stream frames), md.ts (the only HTML
                 from outside text), id.ts
  src/model/     turn_model.ts: the transcript as data, a pure reducer over stream events
                 (history replays through it too); no Vue, no DOM
  src/stores/    Pinia: session (who, can()), config, chats (sidebar), chat (the open chat,
                 its run, queue, held input), attachments, panels (PANEL), ui, theme, admin,
                 viewer (the file open in the in-app viewer)
  src/chat/      ChatView.vue (the chat screen), Markdown.vue (also used by panels), and
                 sidebar/ (chat list with forks under their originals, folders and their
                 instructions (FolderDialog), account menu),
                 transcript/ (turns, activity, approvals, questions, outline, HistoryDialog: what an
                 edit, delete or fork will do, counted, before it is done),
                 composer/ (input, ComposerBar: the + and model menus, shared with a question edited
                 in place; queue, attachments in two lanes, tasks),
                 viewer/ (FileViewer: images and files over the app, never a new tab)
  src/panels/    one folder per panel (<name>/<Name>Panel.vue plus its parts);
                 usePanel.ts; settings/ holds the settings draft (draft.ts) and its store
                 (draft_store.ts), shared by models/, Model defaults and Chat behaviour;
                 SettingsHead (title, status) and SaveBar (the one Save, shown while unsaved)
  src/auth/      sign-in and the waiting room
  src/ui/        app-agnostic widgets: Icon, Modal (given a title, the small dialogs' card),
                 Popover, Switch
  src/styles/    base.css (tokens, layout, panels), chat.css (the transcript)
  public/        copied into dist/ as is: favicon, icons, themes/ (see its README)
test/            node:test suites; evals/ model-behaviour evals (costs API calls)
layout/          the page at real sizes in Chrome (npm run test:layout); outside test/,
                 since node --test runs every file there
```

## Where things go

- **New API route:** add an entry to the matching `server/routes/*.ts`. Every entry declares `feature` (a `FEATURE.*` or `null`; the `Route` type will not compile without it); dispatch and permission are the same table, so there is no separate list to update. A route with a feature gets an `auth` whose `userId` is a scope. `readJson()` gives a JSON object whose fields are `unknown`: check each one (`typeof`, `oneOf()` from `http.ts`) before it goes anywhere typed. The factory's parameter list is its dependencies — add what it needs to `RouteDeps` in `routes/types.ts` and `routeTable()` in `server.ts` if it is new.
- **New query:** a method on the matching `server/store/<area>.ts`, called as `store.<area>.<method>()`, returning the area's row type (node:sqlite rows are untyped, so the result is cast once, there). An area that must touch another area's data calls that area (it is handed in by `store/index.ts`), never its tables.
- **New table or column:** `store/schema.ts` — add to `SCHEMA` or the `migrate()` steps, and bump `SCHEMA_VERSION` when an existing database needs changing. Add the column to the area's row type.
- **New secret setting** (a key, not shape): add it to `SECRET_KEYS` in `access/policy.ts` as well, so it is kept in the secrets file, redacted and fingerprinted only as set/unset.
- **New setting:** its default in `DEFAULTS` and its type in `Config` (`config/config.ts`); DEFAULTS is typed against Config, so the two cannot drift, and `node bin/tinywebui.ts schema > docs/config.schema.json` regenerates the schema (a test compares them). A setting that is a choice from a fixed list keeps its values in `shared/settings.ts`; the page's settings editor must label each one (`Record<T, string>` in `panels/settings/draft.ts`), so a new value will not compile until it has a label.
- **A setting a role may set for its people:** its key in `ROLE_SETTINGS` (`shared/settings.ts`), its check in `roleSettingsProblems` (`access/policy.ts`), applied in `ROLE_OVERRIDES` in `config/models.ts` (or where it is read, as the question timeout is in `chat/runs.ts`), its schema in `cli.ts`, and its words in `ROLE_SETTING_INFO` (`panels/admin/admin_words.ts`), which will not compile until it has them. The role's value wins over the global one and a model's own. If it is about how a turn runs (not the person, as the default model and question timeout are), add it to `ROLE_MODEL_SETTINGS` too, so a role can set it per model (`modelSettings`, over the role's own) and the role editor's Per model group offers it.
- **Text the server writes and the page recognises** (an attachment note, a declined call): one module in `shared/` that both writes and matches it, never a copy of the wording on either side.
- **New built-in tool:** a file in `server/tools/` exporting `xToolDef(): ToolDef` and `callX(args, deps)` (the contract is `tools/types.ts`), registered in `connectHub()` in `server.ts`, and its name added to `RESERVED` in `mcp.ts`.
- **New stream event:** add it to `shared/events.ts` and handle it in `HANDLERS` in `web/src/model/turn_model.ts` (typed against every event, so it will not compile until handled), with a case in `test/turn-model.test.ts` if it changes what is drawn. A stored history must replay to the same model as the live stream (`historyToEvents`).
- **New page code:** state that more than one component reads goes in a store (`web/src/stores/`), loaded by an action; components read the store and call its actions. Imports go one way: `app/` → `panels/` → `chat/` → `stores/` → `model/`, `core/` → `shared/`, `ui/` imports nothing of the app, and `model/` (the transcript reducer) imports only `shared/` (no Vue, no DOM). Stores do nothing on import: their `init()` is called from `app/AppShell.vue`. `test/page-structure.test.js` enforces this. The one store outside `stores/` is the settings draft's (`panels/settings/draft_store.ts`): it is built on `draft.ts`, which `stores/` may not import.
- **New panel:** a folder `web/src/panels/<name>/` whose `<Name>Panel.vue` root is `<section :id="name" :class="{ open: isOpen }">` (a full-column page in `main` is also `container-type: inline-size`, as `#files`/`#mcp` are), using `usePanel(PANEL.X, hooks)`; add the name to `PANEL` in `stores/panels.ts`. Anything that configures the app is a settings section: add it to `SETTINGS_SECTIONS` there, with its group (`you` for what is the person's own, `workspace` for what runs the place) and when it is visible; that is its place in the dialog's rail. Give it a loader in `LOADERS` (`app/lazy.ts`, typed against every `PANEL`, so a new one will not compile without it) and add its name to `SECTIONS` in `app/SettingsDialog.vue`, with `class="set-panel"` on its root. A panel mounts on its first open, after the open: do its loading in `onOpen` (the store calls it for a panel that registers late), not at import or as a side effect of mounting hidden. A page edits the shared settings draft through `useSettingsDraft()` (and joins `DRAFT_PANELS`) or saves on its own; never both for the same key. Only a page about the person's own content or their connected tools (Files, MCP) goes in the main column, in `app/AppShell.vue` (through `LAZY`, as those two are) with a nav item in `chat/sidebar/Sidebar.vue`; keep the sidebar otherwise about chats. Open or close a panel only through the panels store.
- **New API call from the page:** `api.get/post/patch/del` from `web/src/core/api.ts`; it throws on non-2xx with the server's `error` text and `.status`; `api.download` saves a file the server sends. Only the streaming endpoints use `fetch` directly (`stores/chat.ts`). A reply both sides read gets its shape in `shared/api.ts`: the route builds it `satisfies` that type and the page reads it typed, so a renamed field fails to compile instead of showing blank. Areas not yet moved there read loose JSON (`type Json = any`); move an area's replies there when you next work on it.
- **Opening a file or image:** `useViewer().show(items, index)` (`stores/viewer.ts`); never `window.open` or a new tab.
- **New feature flag:** `shared/features.ts`; the page asks `useSession().can(FEATURE.X)`.
- **New searchable corpus:** implement the `Corpus` adapter in `retrieval/retrieval.ts`, add its name to `CORPUS` in `store/embeddings.ts`, and `register()` it.

## Page design

See [docs/architecture.md](docs/architecture.md#page-design) for the why; the rules:

- **A settings page is a column of rows, one setting per row:** inside a `.set-group` (a plain section with an `<h3>` and at most one line of `<p>` under it, split from the next by a rule, never a card of its own), each `.set-grid > div` is `<label for>` (what it is), the control, then `<small>` (what it does, its unit or its range). CSS puts label and help on the left and the control on the right, and stacks them on a phone. Give it `span-2` only when the control needs the width (a prompt, JSON, a row of checkboxes). Units go in the label (`Question timeout (seconds)`), not in a placeholder.
- **Group by what people come to change**, most-changed first; a group of one setting belongs in a neighbouring group. Rarely changed settings go last, in their own group.
- **Save appears only when there is something to save:** draft pages use `SaveBar` at the foot (Discard, Save changes); the header (`SettingsHead`) shows only status. A page that saves on its own (Account, Appearance, Data) puts its button under the fields it saves. A Save sends only the keys that changed (`changedPatch` in `draft.ts`) and names a clash before overwriting someone else's change.
- **Every panel has one header, and it is only a header:** `.panel-head` holds the title, sub-page tabs (as People & roles has), a save status and the close ×, nothing else. A page's own filters and actions (a model filter, New automation, the config file) are the first row of its body, in a `.page-toolbar` as wide as the content. Report pages (Usage) use `.page-body` > `.page-section`, a `.kpis` row for totals, `.data-table` for numbers (right-aligned, tabular figures) and `.kv` for label/value lists; diagnostics go in a collapsed `<details class="page-section page-details">`.
- **Words:** sentence case everywhere, no capitals or monospace for headings; a title matches its rail entry; money reads like money (`$0.0012`, not `$0.001200`); a missing value is `—` with the reason once in a note, not on every tile.
- **Charts use `--chart-1..8`** in that fixed order (a colour-blind-checked palette), never `--accent` or `--err`.
- **Layout follows the room, not the window** ([why](docs/architecture.md#screen-sizes-the-room-not-the-window)): a rule about how much room content has is `@container`, on its host (`main`, `#side`, `#files`/`#mcp`, `.settings-body`, each `container-type: inline-size`), at a width from `CONTAINER_WIDTHS` in `test/page-sizes.test.js` (480px, 640px, 700px, 54rem, 76rem, 14rem). `@media` widths are only the shell (`720px`: drawer, full-screen dialogs) and phone/touch (`640px`, `pointer: coarse`), styling only the shell; `test/page-sizes.test.js` enforces both. Heights use `dvh`, not `vh`. Every menu is `ui/Popover.vue` (it measures its room, flips, caps and scrolls, and is a sheet on a phone), never a box placed by CSS; its outside-click check must include its `el`, which on a phone is under `body`.

## Rules

- SQL lives only in `server/store/`. Nothing else touches `store.db`.
- A JSON column is read with `parseColumn()` (`store/wire.ts`), never a bare `JSON.parse`: a damaged value is left off instead of breaking its chat. Data from outside (a backup) is checked field by field before it is stored (`transfer/backup.ts`).
- The config, secrets and MCP files are written with `writeAtomic()` (`config/config.ts`): to a temporary file, then renamed over the old one.
- A model request is given up after `streamStallMs()` of silence (`harness/provider.ts`, `$TINYWEBUI_STREAM_STALL_MS`, 5 minutes by default), before its reply starts or within it.
- `server/harness/` imports only its own files, `shared/` and `node:` (a test enforces it). What it needs from the app is passed in.
- The store imports nothing from the app (type-only imports of `harness/` wire shapes aside). Folder dependencies are one-way (e.g. `chat/` may use `tools/`, never the reverse); `server.ts` is the only place that wires everything.
- Identifiers shared across files are constants: `EVENT`, `FEATURE`, `CORPUS`. Don't write them as bare strings.
- Logs go through `logger(area)` from `log.ts` (`[tinywebui:<area>] ...`, level from `TINYWEBUI_LOG_LEVEL`). Security events go through `audit()` and are never filtered.
- `tinywebui.config.json` is the deployment's shape and never holds a secret: keys are `${NAME}` references or live in `tinywebui.secrets.json` (`config/secrets.ts`). The secrets file and the database are owner-only (0600).
- Every read of user-owned rows passes a scope (`Scope`: a user id, `null`, or `ALL_USERS`); `undefined` does not compile, and throws on purpose if it gets through anyway.
- Model-written text reaches the page as text (`{{ }}` interpolation) or through `chat/Markdown.vue`, whose `renderMarkdown` escapes first. `v-html` appears nowhere else (the sidebar's `markSnippet`, which escapes too, aside), and no `innerHTML` anywhere (a test enforces both).
- TS in, no build in dev: server code is `.ts` that Node strips and runs, so only erasable syntax (no `enum`, `namespace` or constructor parameter properties; `tsconfig.json` enforces it). Relative imports name the `.ts` file; type-only imports use `import type`. Types go on module boundaries: exports, factory parameters, row shapes. Outside JSON stays `unknown`/loose until it is checked; prefer narrowing to `!` and `as`, and say why when one is needed. `shared/` is the same kind of `.ts`, imported by both sides. The page (`web/`) is TS that Vite strips, checked by `vue-tsc` (on TypeScript 6, since vue-tsc needs the classic compiler API that TypeScript 7 dropped); the same erasable-syntax rule holds there. The page must work under the server's CSP (`script-src 'self'`, `style-src 'self'`, no `unsafe-*`): no runtime template compiler, no inline scripts or `style` attributes in markup (Vue `:style` bindings are fine).
- File names: modules are snake_case (`tool_executor.ts`, `turn_model.ts`), Vue components PascalCase (`ChatView.vue`), and tests are named in kebab-case after what they check (`page-structure.test.js`).
- The page's measured cost (download, DOM size, memory, streaming CPU) is in `docs/performance.md`, with the method. A change to how the transcript renders or streams is measured again that way, and the doc updated if the numbers move.
- Comments explain why, not what.
